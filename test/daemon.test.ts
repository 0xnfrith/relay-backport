// End-to-end against the mock relay: discovery, mentions to sinks, allowlist,
// dedup + replay, invites, reactions, control channel, tampered state.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { controlRequest } from "../src/control";
import { loadConfig, type Config } from "../src/config";
import { startDaemon, type DaemonHandle, WATCH_SUB, WATCH_SUB_PREFIX, MEMBERSHIP_SUB, watchSubId } from "../src/daemon";
import { configureLog } from "../src/log";
import { loadState, saveAllowlist, readControlFiles, statePaths } from "../src/state";
import {
  CHANNEL_A,
  CHANNEL_B,
  MockRelay,
  channelMessage,
  keypair,
  membersEvent,
  metadataEvent,
  now,
  sign,
  waitFor,
} from "./helpers/mock-relay";
import { tmpDir } from "./helpers/tmp";

configureLog({ writer: () => {} });

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

type Setup = {
  relay: MockRelay;
  relaySk: Uint8Array;
  bot: ReturnType<typeof keypair>;
  owner: ReturnType<typeof keypair>;
  stateDir: string;
  keyFile: string;
  lines: string[];
  cfg: (extra?: Record<string, string>) => Config;
  start: (extra?: Record<string, string>, opts?: Parameters<typeof startDaemon>[1]) => Promise<DaemonHandle>;
};

function setup(relayOpts: ConstructorParameters<typeof MockRelay>[0] = { requireAuth: true }): Setup {
  const relay = new MockRelay(relayOpts);
  const relaySk = keypair().sk;
  const bot = keypair();
  const owner = keypair();
  const t = tmpDir();
  const keyFile = `${t.dir}/bot.key`;
  writeFileSync(keyFile, bot.hex + "\n", { mode: 0o600 });
  const stateDir = `${t.dir}/state`;
  const lines: string[] = [];
  cleanups.push(() => relay.stop(), t.cleanup);
  const baseEnv = {
    RELAY_URL: relay.url,
    PRIVATE_KEY_FILE: keyFile,
    STATE_DIR: stateDir,
    OWNER_PUBKEY: owner.pk,
    CONTROL_PORT: "0",
    REDISCOVERY_INTERVAL: "1",
    HEARTBEAT_SECONDS: "1",
  };
  const cfg = (extra: Record<string, string> = {}) => loadConfig({ env: { ...baseEnv, ...extra } });
  const start = async (extra: Record<string, string> = {}, opts: Parameters<typeof startDaemon>[1] = {}) => {
    const loadOptions = { env: { ...baseEnv, ...extra } };
    const d = await startDaemon(loadConfig(loadOptions), {
      loadOptions,
      sinkOptions: { stdoutWriter: (l) => lines.push(l) },
      relayTimings: { authWaitMs: 300 },
      ...opts,
    });
    cleanups.push(() => d.stop());
    return d;
  };
  return { relay, relaySk, bot, owner, stateDir, keyFile, lines, cfg, start };
}

function seedMembership(s: Setup, channels: string[]): void {
  for (const ch of channels) {
    s.relay.store(membersEvent(s.relaySk, ch, [s.bot.pk, s.owner.pk]));
    s.relay.store(metadataEvent(s.relaySk, ch));
  }
}

const mentionLines = (lines: string[]) => lines.filter((l) => l.startsWith("MENTION|"));

// The daemon opens one watch REQ per channel; every test below watches CHANNEL_A.
const WATCH_A = watchSubId(CHANNEL_A);

describe("daemon end to end", () => {
  test("authenticates, discovers membership, subscribes with #h + #p, and prints an owner mention", async () => {
    const s = setup();
    seedMembership(s, [CHANNEL_A]);
    s.relay.store(metadataEvent(s.relaySk, CHANNEL_B, true));
    s.relay.store(membersEvent(s.relaySk, CHANNEL_B, [s.bot.pk])); // archived → skipped
    const d = await s.start();
    await waitFor(() => s.relay.reqsFor(WATCH_A).length >= 1, 5000, "watch sub");
    expect(s.relay.authAttempts[0]).toEqual({ pubkey: s.bot.pk, ok: true });
    expect(d.channels()).toEqual([CHANNEL_A]);
    const watch = s.relay.lastReq(WATCH_A)!;
    expect(watch.filters[0]).toMatchObject({ kinds: [9], "#h": [CHANNEL_A], "#p": [s.bot.pk] });
    expect(s.relay.reqsFor(MEMBERSHIP_SUB).length).toBe(1);

    const m = channelMessage(s.owner.sk, CHANNEL_A, "hello bot", [["p", s.bot.pk]]);
    s.relay.publish(m);
    await waitFor(() => mentionLines(s.lines).length === 1, 5000, "MENTION line");
    const parsed = JSON.parse(mentionLines(s.lines)[0]!.slice("MENTION|".length));
    expect(parsed).toEqual({ kind: 9, from: s.owner.pk.slice(0, 8), h: CHANNEL_A, content: "hello bot", id: m.id, tags: m.tags });
    await d.awaitIdle();
    expect(d.snapshot().counters.delivered).toBe(1);
    expect(s.lines[0]).toBe("EVENT|connected|authed");
  });

  test("one REQ per channel: a relay that only live-pushes single-channel subs still delivers", async () => {
    // Against a live Buzz relay a REQ whose `#h` names every channel at once is
    // accepted and replayed but never pushed, so mentions only surfaced on the
    // next re-assert. Regression guard for that: the mock refuses multi-channel
    // live fan-out here, the way the live relay was measured to behave.
    const s = setup({ requireAuth: true, singleChannelFanOut: true });
    seedMembership(s, [CHANNEL_A, CHANNEL_B]);
    const d = await s.start();
    await waitFor(() => s.relay.reqsWithPrefix(WATCH_SUB_PREFIX).length >= 2, 5000, "per-channel watch subs");
    expect(new Set(d.channels())).toEqual(new Set([CHANNEL_A, CHANNEL_B]));
    for (const ch of [CHANNEL_A, CHANNEL_B]) {
      const req = s.relay.lastReq(watchSubId(ch))!;
      expect(req.filters.every((f) => (f as { "#h"?: string[] })["#h"]?.length === 1)).toBe(true);
      expect(req.filters[0]).toMatchObject({ "#h": [ch], "#p": [s.bot.pk] });
    }
    // no single REQ carries more than its own channel
    expect(s.relay.reqsWithPrefix(WATCH_SUB_PREFIX).every((r) => r.filters.every((f) => (f as { "#h"?: string[] })["#h"]?.length === 1))).toBe(true);

    s.relay.publish(channelMessage(s.owner.sk, CHANNEL_B, "live push", [["p", s.bot.pk]]));
    await waitFor(() => mentionLines(s.lines).length === 1, 3000, "live mention in the second channel");
    expect(mentionLines(s.lines)[0]).toContain("live push");
    await d.awaitIdle();
  });

  test("a watch subscription the relay closes is re-subscribed", async () => {
    const s = setup();
    seedMembership(s, [CHANNEL_A]);
    const d = await s.start();
    await waitFor(() => s.relay.reqsFor(WATCH_A).length >= 1, 5000, "watch sub");
    const before = s.relay.reqsFor(WATCH_A).length;
    s.relay.closeSub(WATCH_A, "error: transient");
    await waitFor(() => s.relay.reqsFor(WATCH_A).length > before, 5000, "re-subscribed after CLOSED");
    s.relay.publish(channelMessage(s.owner.sk, CHANNEL_A, "after close", [["p", s.bot.pk]]));
    await waitFor(() => mentionLines(s.lines).length === 1, 5000, "mention after re-subscribe");
    await d.awaitIdle();
  });

  test("owner literal text mention is delivered; the same text from a stranger is not", async () => {
    const s = setup();
    seedMembership(s, [CHANNEL_A]);
    const d = await s.start({ MENTION_TEXT: "@bot" });
    await waitFor(() => s.relay.reqsFor(WATCH_A).length >= 1);
    expect(s.relay.lastReq(WATCH_A)!.filters[1]).toMatchObject({ authors: [s.owner.pk], "#h": [CHANNEL_A] });
    const stranger = keypair();
    s.relay.publish(channelMessage(stranger.sk, CHANNEL_A, "@bot from stranger"));
    s.relay.publish(channelMessage(s.owner.sk, CHANNEL_A, "@bot from owner"));
    await waitFor(() => mentionLines(s.lines).length === 1);
    await Bun.sleep(150);
    expect(mentionLines(s.lines).length).toBe(1);
    expect(mentionLines(s.lines)[0]).toContain("from owner");
    await d.awaitIdle();
  });

  test("allowlist: strangers are dropped and counted; ptag entries need a p-tag; any entries do not", async () => {
    const s = setup();
    seedMembership(s, [CHANNEL_A]);
    const d = await s.start({ MENTION_TEXT: "@bot" });
    await waitFor(() => s.relay.reqsFor(WATCH_A).length >= 1);
    const files = readControlFiles(statePaths(s.stateDir))!;
    const ctl = (req: Parameters<typeof controlRequest>[1]) => controlRequest({ port: files.port, secret: files.secret }, req);

    const stranger = keypair();
    s.relay.publish(channelMessage(stranger.sk, CHANNEL_A, "psst", [["p", s.bot.pk]]));
    await waitFor(() => d.snapshot().counters.dropped_not_allowed === 1, 5000, "dropped stranger");
    expect(mentionLines(s.lines).length).toBe(0);

    const added = await ctl({ cmd: "allow.add", pubkey: stranger.pk, mode: "ptag", note: "callback" });
    expect(added.ok).toBe(true);
    s.relay.publish(channelMessage(stranger.sk, CHANNEL_A, "now allowed", [["p", s.bot.pk]]));
    await waitFor(() => mentionLines(s.lines).length === 1, 5000, "allowed ptag mention");

    // ptag mode: text-only from a listed key still doesn't count (text is owner-only anyway)
    s.relay.publish(channelMessage(stranger.sk, CHANNEL_A, "@bot no ptag"));
    await Bun.sleep(150);
    expect(mentionLines(s.lines).length).toBe(1);

    const list = await ctl({ cmd: "allow.list" });
    if (!list.ok) throw new Error(list.error);
    expect((list.result as { entries: { pubkey: string; mode: string }[] }).entries).toEqual([
      expect.objectContaining({ pubkey: stranger.pk, mode: "ptag", note: "callback" }),
    ]);
    const removed = await ctl({ cmd: "allow.remove", pubkey: stranger.pk });
    if (!removed.ok) throw new Error(removed.error);
    expect((removed.result as { removed: boolean }).removed).toBe(true);
    s.relay.publish(channelMessage(stranger.sk, CHANNEL_A, "gone again", [["p", s.bot.pk]]));
    await waitFor(() => d.snapshot().counters.dropped_not_allowed === 2);

    // the state file on disk carries signed entries, and the daemon's own key is refused
    const bad = await ctl({ cmd: "allow.add", pubkey: s.bot.pk });
    expect(bad.ok).toBe(false);
    const badMode = await ctl({ cmd: "allow.add", pubkey: stranger.pk, mode: "everyone" });
    expect(badMode.ok).toBe(false);
    await d.awaitIdle();
  });

  test("allowlist entries added via control persist, signed, across a restart", async () => {
    const s = setup();
    seedMembership(s, [CHANNEL_A]);
    const agent = keypair();
    const d1 = await s.start();
    await waitFor(() => s.relay.reqsFor(WATCH_A).length >= 1);
    const files = readControlFiles(statePaths(s.stateDir))!;
    await controlRequest({ port: files.port, secret: files.secret }, { cmd: "allow.add", pubkey: agent.pk, mode: "any" });
    await d1.stop();
    const onDisk = JSON.parse(readFileSync(statePaths(s.stateDir).allowlist, "utf8"));
    expect(onDisk.entries[0].mac).toMatch(/^[0-9a-f]{64}$/);
    // control files are wiped on stop
    expect(readControlFiles(statePaths(s.stateDir))).toBeUndefined();

    const d2 = await s.start();
    await waitFor(() => s.relay.reqsFor(WATCH_A).length >= 2);
    expect(d2.snapshot().allowlist.entries).toBe(1);
    s.relay.publish(channelMessage(agent.sk, CHANNEL_A, "still here", [["p", s.bot.pk]]));
    await waitFor(() => mentionLines(s.lines).length === 1);
    await d2.awaitIdle();
  });

  test("tampered allowlist: entry refused at startup, reported in health, file rewritten", async () => {
    const s = setup();
    seedMembership(s, [CHANNEL_A]);
    const agent = keypair();
    const st = loadState({ stateDir: s.stateDir, ownerPubkey: s.owner.pk });
    st.allowlist.add(agent.pk, "ptag");
    saveAllowlist(st.paths, st.allowlist);
    const file = JSON.parse(readFileSync(st.paths.allowlist, "utf8"));
    file.entries[0].mode = "any";
    writeFileSync(st.paths.allowlist, JSON.stringify(file));

    const d = await s.start();
    await waitFor(() => s.relay.reqsFor(WATCH_A).length >= 1);
    expect(d.snapshot().allowlist.refused).toEqual([{ pubkey: agent.pk, reason: "bad_mac" }]);
    expect(d.snapshot().allowlist.entries).toBe(0);
    expect(JSON.parse(readFileSync(st.paths.allowlist, "utf8")).entries).toEqual([]);
    s.relay.publish(channelMessage(agent.sk, CHANNEL_A, "hi", [["p", s.bot.pk]]));
    await waitFor(() => d.snapshot().counters.dropped_not_allowed === 1);
  });

  test("missing signing key with an existing allowlist refuses to start (exit 1)", async () => {
    const s = setup();
    const st = loadState({ stateDir: s.stateDir });
    st.allowlist.add(keypair().pk, "any");
    saveAllowlist(st.paths, st.allowlist);
    unlinkSync(st.paths.signingKey);
    let err: unknown;
    try {
      await startDaemon(s.cfg(), { sinkOptions: { stdoutWriter: () => {} } });
    } catch (e) {
      err = e;
    }
    expect((err as { exitCode?: number }).exitCode).toBe(1);
    expect(String((err as Error).message)).toMatch(/signing.key is missing/);
  });

  test("dedup: a replayed event is delivered once; restart replays only the gap and skips persisted ids", async () => {
    const s = setup();
    seedMembership(s, [CHANNEL_A]);
    const d1 = await s.start();
    await waitFor(() => s.relay.reqsFor(WATCH_A).length >= 1);
    const m1 = channelMessage(s.owner.sk, CHANNEL_A, "one", [["p", s.bot.pk]]);
    s.relay.publish(m1);
    await waitFor(() => mentionLines(s.lines).length === 1);
    await d1.awaitIdle();
    // rediscovery re-asserts the watch REQ → the relay replays m1 → must be deduplicated
    await waitFor(() => s.relay.reqsFor(WATCH_A).length >= 2, 5000, "re-asserted watch");
    await Bun.sleep(200);
    expect(mentionLines(s.lines).length).toBe(1);
    expect(d1.snapshot().counters.dropped_duplicate).toBeGreaterThanOrEqual(1);
    await d1.stop();

    // while "down": a second mention lands
    const m2 = channelMessage(s.owner.sk, CHANNEL_A, "two", [["p", s.bot.pk]]);
    s.relay.store(m2);
    expect(readFileSync(statePaths(s.stateDir).seen, "utf8")).toContain(m1.id);
    const cursor = Number(readFileSync(statePaths(s.stateDir).cursor, "utf8"));
    expect(cursor).toBeGreaterThan(0);

    const d2 = await s.start();
    await waitFor(() => mentionLines(s.lines).length === 2, 5000, "gap replay");
    expect(mentionLines(s.lines)[1]).toContain(m2.id);
    const watch = s.relay.lastReq(WATCH_A)!;
    expect(watch.filters[0]!.since).toBeLessThanOrEqual(cursor - 60);
    expect(watch.filters[0]!.since).toBeGreaterThanOrEqual(now() - 86_400);
    await Bun.sleep(150);
    expect(mentionLines(s.lines).length).toBe(2);
    await d2.awaitIdle();
  });

  test("invite: a membership notification joins the channel and a same-second mention is caught", async () => {
    const s = setup();
    const d = await s.start();
    await waitFor(() => s.relay.reqsFor(MEMBERSHIP_SUB).length >= 1);
    expect(d.channels()).toEqual([]);
    const ts = now();
    const join = sign(s.relaySk, { kind: 44100, created_at: ts, content: "", tags: [["p", s.bot.pk], ["h", CHANNEL_B]] });
    s.relay.store(join);
    s.relay.store(channelMessage(s.owner.sk, CHANNEL_B, "welcome", [["p", s.bot.pk]]));
    s.relay.publish(join);
    await waitFor(() => d.channels().includes(CHANNEL_B), 5000, "joined");
    await waitFor(() => mentionLines(s.lines).length === 1, 5000, "mention after invite");
    const leave = sign(s.relaySk, { kind: 44101, created_at: ts + 1, content: "", tags: [["p", s.bot.pk], ["h", CHANNEL_B]] });
    s.relay.publish(leave);
    await waitFor(() => !d.channels().includes(CHANNEL_B), 5000, "left");
    await d.awaitIdle();
  });

  test("rediscovery picks up a new channel without a restart", async () => {
    const s = setup();
    const d = await s.start();
    await waitFor(() => s.relay.reqsFor(WATCH_SUB).length >= 1, 5000, "global fallback sub");
    seedMembership(s, [CHANNEL_A]);
    await waitFor(() => d.channels().includes(CHANNEL_A), 5000, "rediscovered");
    s.relay.publish(channelMessage(s.owner.sk, CHANNEL_A, "found", [["p", s.bot.pk]]));
    await waitFor(() => mentionLines(s.lines).length === 1);
    await d.awaitIdle();
  });

  test("webhook sink receives the mention; stdout and webhook run together", async () => {
    const s = setup();
    seedMembership(s, [CHANNEL_A]);
    const got: Record<string, unknown>[] = [];
    const hook = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        got.push((await req.json()) as Record<string, unknown>);
        return new Response("ok");
      },
    });
    cleanups.push(() => hook.stop(true));
    const d = await s.start({ SINKS: "stdout,webhook", WEBHOOK_URL: `http://127.0.0.1:${hook.port}/h` });
    await waitFor(() => s.relay.reqsFor(WATCH_A).length >= 1);
    const m = channelMessage(s.owner.sk, CHANNEL_A, "to hook", [["p", s.bot.pk]]);
    s.relay.publish(m);
    await waitFor(() => got.length === 1 && mentionLines(s.lines).length === 1);
    expect(got[0]).toMatchObject({ source: "buzz", channel: CHANNEL_A, event_id: m.id, text: "to hook", author: s.owner.pk });
    await d.awaitIdle();
    expect(d.snapshot().sinks).toEqual(["stdout", "webhook"]);
    expect(d.snapshot().counters.delivered).toBe(1);
  });

  test("a failing sink leaves the id unpersisted so a restart redelivers it", async () => {
    const s = setup();
    seedMembership(s, [CHANNEL_A]);
    const d = await s.start({ SINKS: "stdout,webhook", WEBHOOK_URL: "http://127.0.0.1:1/h", WEBHOOK_ATTEMPTS: "1" });
    await waitFor(() => s.relay.reqsFor(WATCH_A).length >= 1);
    const m = channelMessage(s.owner.sk, CHANNEL_A, "flaky", [["p", s.bot.pk]]);
    s.relay.publish(m);
    await waitFor(() => d.snapshot().counters.delivery_failed === 1, 8000, "delivery failure");
    await d.stop();
    const seenPath = statePaths(s.stateDir).seen;
    const seenText = existsSync(seenPath) ? readFileSync(seenPath, "utf8") : "";
    expect(seenText.includes(m.id)).toBe(false);
  });

  test("reactions: 👀/💬 on an owner mention, deleted when our own reply lands", async () => {
    const s = setup();
    seedMembership(s, [CHANNEL_A]);
    const d = await s.start({ REACTIONS: "true" });
    await waitFor(() => s.relay.reqsFor(WATCH_A).length >= 1);
    const watch = s.relay.lastReq(WATCH_A)!;
    expect(watch.filters.some((f) => f.authors?.[0] === s.bot.pk && f.kinds?.includes(45003))).toBe(true);
    const m = channelMessage(s.owner.sk, CHANNEL_A, "react please", [["p", s.bot.pk]]);
    s.relay.publish(m);
    await waitFor(() => s.relay.published.filter((e) => e.kind === 7).length === 2, 5000, "two reactions");
    const reactions = s.relay.published.filter((e) => e.kind === 7);
    expect(reactions.map((e) => e.content).sort()).toEqual(["👀", "💬"]);
    expect(reactions.every((e) => e.tags[0]?.[1] === m.id)).toBe(true);
    expect(d.snapshot().reactions.pending).toBe(1);

    // a stranger's mention (dropped) must not get reactions
    s.relay.publish(channelMessage(keypair().sk, CHANNEL_A, "me too", [["p", s.bot.pk]]));
    await waitFor(() => d.snapshot().counters.dropped_not_allowed === 1);
    expect(s.relay.published.filter((e) => e.kind === 7).length).toBe(2);

    // our reply → NIP-09 deletes of both reaction ids
    s.relay.publish(channelMessage(s.bot.sk, CHANNEL_A, "on it", [["p", s.owner.pk]]));
    await waitFor(() => s.relay.published.filter((e) => e.kind === 5).length === 2, 5000, "two deletions");
    const deletes = s.relay.published.filter((e) => e.kind === 5);
    expect(deletes.map((e) => e.tags[0]?.[1]).sort()).toEqual(reactions.map((e) => e.id).sort());
    expect(d.snapshot().reactions.pending).toBe(0);
    await d.awaitIdle();
  });

  test("forum kinds are watched when configured; a forum reply carries rootId; unconfigured kinds are never subscribed", async () => {
    const s = setup();
    seedMembership(s, [CHANNEL_A]);
    const d = await s.start({ KINDS: "9,45001,45003", MENTION_TEXT: "@bot" });
    await waitFor(() => s.relay.reqsFor(WATCH_A).length >= 1);
    expect(s.relay.lastReq(WATCH_A)!.filters[0]!.kinds).toEqual([9, 45001, 45003]);
    const root = "c".repeat(64);
    s.relay.publish(channelMessage(s.owner.sk, CHANNEL_A, "forum reply", [["e", root], ["p", s.bot.pk]], 45003));
    await waitFor(() => mentionLines(s.lines).length === 1);
    expect(JSON.parse(mentionLines(s.lines)[0]!.slice(8)).rootId).toBe(root);
    // forum posts (45001) carry no p-tag on some relays: the owner's literal text still wakes us
    s.relay.publish(channelMessage(s.owner.sk, CHANNEL_A, "@bot forum post", [], 45001));
    await waitFor(() => mentionLines(s.lines).length === 2);
    expect(JSON.parse(mentionLines(s.lines)[1]!.slice(8)).kind).toBe(45001);
    // a kind we did not configure is not in any filter, so the relay never sends it
    s.relay.publish(channelMessage(s.owner.sk, CHANNEL_A, "typing", [["p", s.bot.pk]], 20002));
    await Bun.sleep(150);
    expect(mentionLines(s.lines).length).toBe(2);
    expect(s.relay.lastReq(WATCH_A)!.filters.every((f) => !f.kinds?.includes(20002))).toBe(true);
    await d.awaitIdle();
  });

  test("reconnects after the relay drops the socket and keeps delivering", async () => {
    const s = setup();
    seedMembership(s, [CHANNEL_A]);
    const d = await s.start();
    await waitFor(() => s.relay.reqsFor(WATCH_A).length >= 1);
    s.relay.dropAll();
    await waitFor(() => s.lines.some((l) => l.startsWith("EVENT|closed|")), 5000, "closed line");
    await waitFor(() => s.relay.authAttempts.length === 2, 8000, "reconnected + re-authed");
    await waitFor(() => s.relay.reqsFor(WATCH_A).length >= 2, 5000, "re-subscribed");
    s.relay.publish(channelMessage(s.owner.sk, CHANNEL_A, "after reconnect", [["p", s.bot.pk]]));
    await waitFor(() => mentionLines(s.lines).length === 1);
    expect(d.snapshot().counters.reconnects).toBe(1);
    await d.awaitIdle();
  });

  test("auth rejection exits with code 3; unreachable relay exits with code 2", async () => {
    const s = setup({ requireAuth: true, allowPubkeys: [] });
    const d = await startDaemon(s.cfg(), { sinkOptions: { stdoutWriter: (l) => s.lines.push(l) }, relayTimings: { authWaitMs: 200 } });
    expect(await d.exited).toBe(3);
    expect(s.lines.some((l) => l.startsWith("EVENT|auth-failed|"))).toBe(true);

    const s2 = setup();
    const d2 = await startDaemon(s2.cfg({ RELAY_URL: "ws://127.0.0.1:1" }), { sinkOptions: { stdoutWriter: () => {} } });
    expect(await d2.exited).toBe(2);
  });

  test("control: status reflects the daemon, reload re-reads the config, stop exits 0", async () => {
    const s = setup();
    seedMembership(s, [CHANNEL_A]);
    const d = await s.start();
    await waitFor(() => s.relay.reqsFor(WATCH_A).length >= 1);
    const files = readControlFiles(statePaths(s.stateDir))!;
    const ctl = (req: Parameters<typeof controlRequest>[1]) => controlRequest({ port: files.port, secret: files.secret }, req);
    const status = await ctl({ cmd: "status" });
    if (!status.ok) throw new Error(status.error);
    const r = status.result as { connected: boolean; channels: number; pubkey: string; control_port: number };
    expect(r.connected).toBe(true);
    expect(r.channels).toBe(1);
    expect(r.pubkey).toBe(s.bot.pk);
    expect(r.control_port).toBe(files.port);
    const reload = await ctl({ cmd: "reload" });
    expect(reload.ok).toBe(true);
    const stop = await ctl({ cmd: "stop" });
    expect(stop.ok).toBe(true);
    expect(await d.exited).toBe(0);
  });

  test("health endpoint serves JSON", async () => {
    const s = setup();
    seedMembership(s, [CHANNEL_A]);
    const d = await s.start({ HEALTH_PORT: "0" });
    // 0 disables; pick a real port via a second daemon config is heavy, so exercise the server directly
    await waitFor(() => s.relay.reqsFor(WATCH_A).length >= 1);
    expect(d.healthPort).toBeUndefined();
    const { startHealthServer } = await import("../src/health");
    const h = startHealthServer({ host: "127.0.0.1", port: 0, snapshot: () => d.snapshot() });
    cleanups.push(h.stop);
    const res = await fetch(`http://127.0.0.1:${h.port}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; connected: boolean; counters: unknown };
    expect(body.ok).toBe(true);
    expect(body.connected).toBe(true);
    expect(body.counters).toBeDefined();
    expect((await fetch(`http://127.0.0.1:${h.port}/nope`)).status).toBe(404);
  });
});
