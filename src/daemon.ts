// The daemon: relay connection lifecycle, discovery, mention pipeline,
// allowlist, sinks, reactions, control channel, health, heartbeat.
import { randomBytes } from "node:crypto";
import type { Event, Filter } from "nostr-tools";
import { isAllowMode } from "./allowlist";
import { loadConfig, describeConfig, type Config, type LoadOptions } from "./config";
import { startControlServer, type ControlRequest, type ControlResponse } from "./control";
import { startHealthServer, type HealthSnapshot } from "./health";
import { parsePubkey } from "./keys";
import { log, errMessage, registerSecret } from "./log";
import {
  KIND_CHANNEL_MESSAGE,
  KIND_FORUM_REPLY,
  KIND_GROUP_MEMBERS,
  KIND_GROUP_METADATA,
  MEMBERSHIP_KINDS,
  classify,
  isEphemeralKind,
  membershipAction,
  mergeDiscoveredChannels,
  threadRoot,
  type MentionRecord,
} from "./mention";
import { ReactionManager } from "./reactions";
import { AuthError, ConnectError, RelayClient, nextBackoff, BACKOFF_MIN_MS } from "./relay";
import { buildSinks, type Sink, type SinkFactoryOptions } from "./sinks/index";
import {
  SeenStore,
  loadState,
  readCursor,
  removeControlFiles,
  replaySince,
  saveAllowlist,
  writeControlFiles,
  writeCursor,
  type LoadedState,
} from "./state";
import { VERSION } from "./version";

export const WATCH_SUB = "watch";
export const MEMBERSHIP_SUB = "membership";

export type DaemonOptions = {
  resetAllowlist?: boolean;
  /** Re-used for `reload`: how the config was loaded the first time. */
  loadOptions?: LoadOptions;
  sinkOptions?: SinkFactoryOptions;
  /** Give up after the first connection failure instead of retrying (exit 2). */
  exitOnFirstConnectFailure?: boolean;
  /** Test seam: relay client timings. */
  relayTimings?: { authWaitMs?: number; pingIntervalMs?: number; staleAfterMs?: number };
};

export type DaemonHandle = {
  /** Resolves with the process exit code once the daemon has fully stopped. */
  exited: Promise<number>;
  stop: (code?: number) => Promise<void>;
  snapshot: () => HealthSnapshot;
  controlPort: number;
  healthPort: number | undefined;
  /** Test seams. */
  channels: () => string[];
  relay: () => RelayClient | undefined;
  awaitIdle: () => Promise<void>;
};

type Counters = HealthSnapshot["counters"];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function startDaemon(initial: Config, opts: DaemonOptions = {}): Promise<DaemonHandle> {
  let cfg = initial;
  const startedAt = Date.now();

  // --- state -------------------------------------------------------------
  const state: LoadedState = loadState({
    stateDir: cfg.stateDir,
    ownerPubkey: cfg.ownerPubkey,
    resetAllowlist: opts.resetAllowlist,
  });
  const seen = new SeenStore(state.paths.seen);
  let lastBeat = readCursor(state.paths.cursor);

  const counters: Counters = {
    received: 0,
    mentions: 0,
    delivered: 0,
    delivery_failed: 0,
    dropped_not_allowed: 0,
    dropped_self: 0,
    dropped_duplicate: 0,
    dropped_kind: 0,
    reconnects: 0,
  };
  let lastEventAt: number | null = null;
  let channels: string[] = [];
  let relay: RelayClient | undefined;
  let stopping = false;
  let exitCode = 0;
  let resolveExited: (code: number) => void = () => {};
  const exited = new Promise<number>((r) => (resolveExited = r));
  let deliveryQueue: Promise<unknown> = Promise.resolve();
  let sinks: Sink[] = buildSinks(cfg, opts.sinkOptions);

  const reactions = new ReactionManager(
    async (tmpl) => {
      if (!relay?.connected) return null;
      const res = await relay.publish(tmpl);
      if (!res.ok) log.warn("reaction publish rejected", { kind: tmpl.kind, message: res.message });
      return res.ok ? res.id : null;
    },
    { sweepAfterMs: cfg.reactionSweepSeconds * 1000 },
  );

  const snapshot = (): HealthSnapshot => ({
    ok: Boolean(relay?.connected),
    version: VERSION,
    pubkey: cfg.pubkey,
    relay: cfg.relayUrl,
    connected: Boolean(relay?.connected),
    authed: Boolean(relay?.authed),
    uptime_s: Math.floor((Date.now() - startedAt) / 1000),
    channels: channels.length,
    last_event_at: lastEventAt,
    sinks: sinks.map((s) => s.name),
    counters: { ...counters },
    allowlist: {
      owner: state.allowlist.owner ?? null,
      entries: state.allowlist.size(),
      refused: state.refused,
    },
    reactions: { enabled: cfg.reactions, pending: reactions.pendingCount },
    control_port: 0,
  });

  // --- control channel ---------------------------------------------------
  const controlSecret = randomBytes(32).toString("hex");
  registerSecret(controlSecret);

  const handleControl = async (req: ControlRequest): Promise<ControlResponse> => {
    switch (req.cmd) {
      case "status":
        return { ok: true, result: { ...snapshot(), control_port: control.port, config: describeConfig(cfg) } };
      case "allow.list":
        return {
          ok: true,
          result: {
            owner: state.allowlist.owner ?? null,
            entries: state.allowlist.list().map(({ mac: _mac, ...rest }) => rest),
            refused: state.refused,
          },
        };
      case "allow.add": {
        let pubkey: string;
        try {
          pubkey = parsePubkey(req.pubkey ?? "");
        } catch (err) {
          return { ok: false, error: errMessage(err), code: "bad_request" };
        }
        const mode = req.mode ?? "ptag";
        if (!isAllowMode(mode)) return { ok: false, error: 'mode must be "ptag" or "any"', code: "bad_request" };
        if (pubkey === cfg.pubkey) return { ok: false, error: "that is the daemon's own key", code: "bad_request" };
        const entry = state.allowlist.add(pubkey, mode, req.note);
        saveAllowlist(state.paths, state.allowlist);
        log.info("allowlist add", { pubkey, mode, note: entry.note ?? "" });
        const { mac: _mac, ...visible } = entry;
        return { ok: true, result: visible };
      }
      case "allow.remove": {
        let pubkey: string;
        try {
          pubkey = parsePubkey(req.pubkey ?? "");
        } catch (err) {
          return { ok: false, error: errMessage(err), code: "bad_request" };
        }
        const removed = state.allowlist.remove(pubkey);
        if (removed) {
          saveAllowlist(state.paths, state.allowlist);
          log.info("allowlist remove", { pubkey });
        }
        return { ok: true, result: { removed, pubkey } };
      }
      case "reload": {
        try {
          const next = loadConfig({ ...(opts.loadOptions ?? {}), overrides: opts.loadOptions?.overrides });
          const changed = applyReload(next);
          return { ok: true, result: { sinks: sinks.map((s) => s.name), changed } };
        } catch (err) {
          return { ok: false, error: `reload failed: ${errMessage(err)}`, code: "failed" };
        }
      }
      case "stop":
        setTimeout(() => void stop(0), 10);
        return { ok: true, result: { stopping: true } };
    }
  };

  const control = startControlServer({ port: cfg.controlPort, secret: controlSecret, handler: handleControl });
  writeControlFiles(state.paths, controlSecret, control.port);
  log.info("control channel listening", { port: control.port });

  // --- health --------------------------------------------------------------
  let health: { port: number; stop: () => void } | undefined;
  if (cfg.healthPort > 0) {
    health = startHealthServer({
      host: cfg.healthHost,
      port: cfg.healthPort,
      snapshot: () => ({ ...snapshot(), control_port: control.port }),
    });
  }

  // --- reload ------------------------------------------------------------
  function applyReload(next: Config): string[] {
    const changed: string[] = [];
    const fixed: (keyof Config)[] = ["relayUrl", "pubkey", "stateDir", "controlPort", "healthPort"];
    for (const key of fixed) {
      if (JSON.stringify(next[key]) !== JSON.stringify(cfg[key])) {
        log.warn("reload: change requires a restart, ignored", { key });
      }
    }
    if (JSON.stringify(next.sinks) !== JSON.stringify(cfg.sinks) || next.webhook !== undefined || next.exec !== undefined) {
      const fresh = buildSinks(next, opts.sinkOptions);
      const old = sinks;
      sinks = fresh;
      for (const s of old) void s.close?.();
      changed.push("sinks");
    }
    if (next.mentionText !== cfg.mentionText) changed.push("mention_text");
    if (JSON.stringify(next.kinds) !== JSON.stringify(cfg.kinds)) changed.push("kinds");
    if (next.reactions !== cfg.reactions) changed.push("reactions");
    if (next.ownerPubkey !== cfg.ownerPubkey) {
      state.allowlist.setOwner(next.ownerPubkey);
      changed.push("owner_pubkey");
    }
    cfg = {
      ...cfg,
      sinks: next.sinks,
      webhook: next.webhook,
      exec: next.exec,
      acp: next.acp,
      mentionText: next.mentionText,
      kinds: next.kinds,
      reactions: next.reactions,
      ownerPubkey: next.ownerPubkey,
      rediscoveryIntervalSeconds: next.rediscoveryIntervalSeconds,
    };
    if (changed.some((c) => c === "mention_text" || c === "kinds" || c === "reactions" || c === "owner_pubkey")) {
      subscribeWatch(Math.floor(Date.now() / 1000) - 120);
    }
    log.info("config reloaded", { changed });
    return changed;
  }

  // --- subscriptions -------------------------------------------------------
  function watchFilters(since: number): Filter[] {
    const filters: Filter[] = [];
    if (channels.length === 0) {
      filters.push({ kinds: cfg.kinds, "#p": [cfg.pubkey], since });
      return filters;
    }
    filters.push({ kinds: cfg.kinds, "#h": channels, "#p": [cfg.pubkey], since });
    if (cfg.mentionText && cfg.ownerPubkey) {
      filters.push({ kinds: cfg.kinds, "#h": channels, authors: [cfg.ownerPubkey], since });
    }
    if (cfg.reactions) {
      filters.push({ kinds: [KIND_CHANNEL_MESSAGE, KIND_FORUM_REPLY], "#h": channels, authors: [cfg.pubkey], since });
    }
    return filters;
  }

  function subscribeWatch(since: number): void {
    if (!relay?.connected) return;
    relay.req(WATCH_SUB, watchFilters(since), {
      onEvent: (ev) => void handleEvent(ev),
      onClosed: (reason) => log.warn("watch subscription closed by relay", { reason }),
    });
    log.debug("watch subscribed", { channels: channels.length, since });
  }

  function subscribeMembership(since: number): void {
    if (!relay?.connected) return;
    relay.req(MEMBERSHIP_SUB, [{ kinds: MEMBERSHIP_KINDS, "#p": [cfg.pubkey], since }], {
      onEvent: (ev) => handleMembership(ev),
      onClosed: (reason) => log.warn("membership subscription closed by relay", { reason }),
    });
  }

  async function discover(): Promise<boolean> {
    if (!relay?.connected) return false;
    const members = await relay.query([{ kinds: [KIND_GROUP_MEMBERS], "#p": [cfg.pubkey] }]);
    if (!members.eosed) {
      log.warn("discovery: members query did not complete");
      return false;
    }
    const ids = mergeDiscoveredChannels(members.events, []);
    let metas: Event[] = [];
    if (ids.length > 0) {
      const res = await relay.query([{ kinds: [KIND_GROUP_METADATA], "#d": ids }]);
      if (!res.eosed) {
        log.warn("discovery: metadata query did not complete");
        return false;
      }
      metas = res.events;
    }
    const next = mergeDiscoveredChannels(members.events, metas);
    const changed = next.length !== channels.length || next.some((id) => !channels.includes(id));
    if (changed) {
      log.info("discovered channels", { count: next.length, added: next.filter((c) => !channels.includes(c)).length });
      channels = next;
    }
    return changed;
  }

  function handleMembership(ev: Event): void {
    const action = membershipAction(ev, cfg.pubkey);
    if (action.type === "ignore") return;
    if (action.type === "join") {
      if (!channels.includes(action.channelId)) {
        channels = [...channels, action.channelId];
        log.info("joined channel", { channel: action.channelId });
        subscribeWatch(Math.min(action.since, Math.floor(Date.now() / 1000) - 120));
      }
      return;
    }
    if (channels.includes(action.channelId)) {
      channels = channels.filter((c) => c !== action.channelId);
      log.info("left channel", { channel: action.channelId });
      subscribeWatch(Math.floor(Date.now() / 1000) - 120);
    }
  }

  // --- mention pipeline ----------------------------------------------------
  async function handleEvent(ev: Event): Promise<void> {
    counters.received++;
    lastEventAt = ev.created_at;
    if (MEMBERSHIP_KINDS.includes(ev.kind)) {
      handleMembership(ev);
      return;
    }
    const c = classify(ev, { selfPubkey: cfg.pubkey, ownerPubkey: cfg.ownerPubkey, mentionText: cfg.mentionText });
    if (c.fromSelf) {
      counters.dropped_self++;
      if (cfg.reactions && (ev.kind === KIND_CHANNEL_MESSAGE || ev.kind === KIND_FORUM_REPLY) && c.channel) {
        const cleared = await reactions.onOwnReply(c.channel);
        if (cleared) log.debug("cleared reactions after own reply", { channel: c.channel, cleared });
      }
      return;
    }
    if (isEphemeralKind(ev.kind) || !cfg.kinds.includes(ev.kind)) {
      counters.dropped_kind++;
      return;
    }
    if (seen.has(ev.id)) {
      counters.dropped_duplicate++;
      return;
    }
    seen.markInMemory(ev.id);
    const mentioned = c.ptag || c.text;
    if (!mentioned) return;
    counters.mentions++;

    const decision = state.allowlist.decide(ev.pubkey, { ptag: c.ptag, text: c.text });
    if (!decision.allowed) {
      counters.dropped_not_allowed++;
      log.info("mention dropped: sender not allowed", {
        from: ev.pubkey.slice(0, 8),
        reason: decision.reason,
        channel: c.channel,
      });
      return;
    }

    if (cfg.reactions && c.fromOwner && c.channel) void reactions.react(ev.id, c.channel);

    const record: MentionRecord = {
      event: ev,
      relay: cfg.relayUrl,
      channel: c.channel,
      threadRoot: threadRoot(ev),
      rootId: c.rootId,
      ptag: c.ptag,
      text: c.text,
      fromOwner: c.fromOwner,
      allowedBy: decision.by,
      receivedAt: Math.floor(Date.now() / 1000),
    };
    deliveryQueue = deliveryQueue.then(() => deliver(record)).catch(() => {});
  }

  async function deliver(record: MentionRecord): Promise<void> {
    const results = await Promise.all(
      sinks.map(async (s) => {
        try {
          return await s.deliver(record);
        } catch (err) {
          log.error("sink threw", { sink: s.name, error: errMessage(err) });
          return false;
        }
      }),
    );
    if (results.every(Boolean)) {
      counters.delivered++;
      seen.persist(record.event.id);
      log.info("mention delivered", {
        event: record.event.id,
        from: record.event.pubkey.slice(0, 8),
        channel: record.channel,
        by: record.allowedBy,
        sinks: sinks.length,
      });
    } else {
      counters.delivery_failed++;
      log.warn("mention not fully delivered", {
        event: record.event.id,
        failed: sinks.filter((_, i) => !results[i]).map((s) => s.name),
      });
    }
  }

  // --- connection lifecycle ------------------------------------------------
  let rediscoveryTimer: ReturnType<typeof setInterval> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  let connectedAt = 0;
  let reconnectWaiter: ((v: void) => void) | undefined;

  function clearTimers(): void {
    if (rediscoveryTimer) clearInterval(rediscoveryTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (sweepTimer) clearInterval(sweepTimer);
    rediscoveryTimer = heartbeatTimer = sweepTimer = undefined;
  }

  function lifecycle(event: Parameters<NonNullable<Sink["lifecycle"]>>[0]): void {
    for (const s of sinks) {
      try {
        s.lifecycle?.(event);
      } catch {
        // ignore
      }
    }
  }

  async function connectOnce(): Promise<void> {
    const client = new RelayClient({
      url: cfg.wsUrl,
      secretKey: cfg.secretKey,
      pubkey: cfg.pubkey,
      authWaitMs: opts.relayTimings?.authWaitMs,
      pingIntervalMs: opts.relayTimings?.pingIntervalMs,
      staleAfterMs: opts.relayTimings?.staleAfterMs,
      onClose: (code, reason) => {
        clearTimers();
        log.warn("relay disconnected", { code, reason });
        lifecycle({ type: "closed", code, reason });
        reconnectWaiter?.();
      },
      onError: (message) => {
        if (message.startsWith("auth-failed")) {
          lifecycle({ type: "auth-failed", message });
          void stop(3);
          return;
        }
        lifecycle({ type: "error", message });
      },
      onNotice: (message) => log.debug("relay notice", { message }),
      onReauthed: () => log.info("re-authenticated after auth-required"),
    });
    relay = client;
    const result = await client.connect();
    connectedAt = Date.now();
    log.info("relay connected", { auth: result });
    lifecycle({ type: "connected", authed: result === "authed" });

    const now = Math.floor(Date.now() / 1000);
    const since = replaySince(lastBeat, now, cfg.replayWindowMaxSeconds);
    subscribeMembership(since);
    await discover();
    subscribeWatch(since);
    log.info("watching", { channels: channels.length, replay_from: since, replay_s: now - since });

    const beat = () => {
      if (!client.connected) return;
      lastBeat = Math.floor(Date.now() / 1000);
      writeCursor(state.paths.cursor, lastBeat);
    };
    beat();
    heartbeatTimer = setInterval(beat, cfg.heartbeatSeconds * 1000);
    rediscoveryTimer = setInterval(() => {
      discover()
        .then((changed) => {
          // Re-assert the watch either way: relay-side subs have been seen to
          // die silently while the socket stayed up.
          subscribeWatch(Math.floor(Date.now() / 1000) - 120);
          if (changed) log.debug("rediscovery applied");
        })
        .catch((err) => log.warn("rediscovery failed", { error: errMessage(err) }));
    }, cfg.rediscoveryIntervalSeconds * 1000);
    if (cfg.reactions) {
      sweepTimer = setInterval(() => void reactions.sweep(), 25_000);
    }
  }

  async function run(): Promise<void> {
    let backoff = BACKOFF_MIN_MS;
    let first = true;
    while (!stopping) {
      try {
        await connectOnce();
      } catch (err) {
        if (err instanceof AuthError) {
          log.error("authentication failed", { error: errMessage(err) });
          lifecycle({ type: "auth-failed", message: errMessage(err) });
          exitCode = 3;
          break;
        }
        const message = errMessage(err);
        if (first && opts.exitOnFirstConnectFailure !== false) {
          log.error("cannot connect to relay", { error: message });
          exitCode = 2;
          break;
        }
        log.warn("connect failed, retrying", { error: message, backoff_ms: backoff });
        counters.reconnects++;
        await sleep(backoff);
        backoff = nextBackoff(backoff, 0);
        continue;
      }
      first = false;
      // Wait for the socket to close.
      await new Promise<void>((r) => (reconnectWaiter = r));
      reconnectWaiter = undefined;
      const uptime = Date.now() - connectedAt;
      relay = undefined;
      if (stopping) break;
      counters.reconnects++;
      backoff = nextBackoff(backoff, uptime);
      log.info("reconnecting", { backoff_ms: backoff });
      await sleep(backoff);
    }
  }

  async function stop(code = 0): Promise<void> {
    if (stopping) return;
    stopping = true;
    if (code !== 0) exitCode = code;
    clearTimers();
    relay?.disconnect();
    reconnectWaiter?.();
    await deliveryQueue;
    for (const s of sinks) {
      try {
        await s.close?.();
      } catch {
        // ignore
      }
    }
    health?.stop();
    control.stop();
    removeControlFiles(state.paths);
    log.info("stopped", { code: exitCode });
    resolveExited(exitCode);
  }

  void run().then(() => {
    if (!stopping) void stop(exitCode);
  });

  return {
    exited,
    stop,
    snapshot: () => ({ ...snapshot(), control_port: control.port }),
    controlPort: control.port,
    healthPort: health?.port,
    channels: () => [...channels],
    relay: () => relay,
    awaitIdle: async () => {
      await deliveryQueue;
    },
  };
}
