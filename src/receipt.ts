// Delivery receipt: a kind:7 reaction on the event that woke us, signed by
// the harness identity, so the author can see the wake was received even
// while the consumer behind the sinks is still working.
//
// There is no other publish path in this process — the harness owns the
// long-lived relay socket. When receipts are on, we open a one-shot NIP-01
// websocket to the same URL, answer NIP-42 AUTH if the relay asks (including
// a late auth-required OK after EVENT), publish the reaction, and close.
// Failure is a single warning; delivery already happened and is never rolled
// back.
//
// Off by default. At-least-once per event id: `pending <id>` is written
// before the publish and `done <id>` after the relay's OK. A pending line
// is retried once on start; if that retry fails it becomes `gave_up` (counts
// as done). The cap evicts only done/gave_up rows — never pending. Compacted
// to the newest `maxSeen` settled ids (default 5000).
import { accessSync, constants, createReadStream, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { finalizeEvent, getPublicKey, nip19 } from "nostr-tools";
import { DEFAULT_RECEIPT_SEEN_NAME, DEFAULT_RECEIPT_MAX_SEEN } from "./config";
import type { Delivery, EventSource } from "./delivery";
import { log, errMessage } from "./log";

export const KIND_REACTION = 7;
export const KIND_AUTH = 22242;

const HEX64 = /^[0-9a-f]{64}$/i;

export type ReceiptSkipReason = "disabled" | "not-delivered" | "own" | "seen" | "no-event" | "synthetic" | "no-scope";

export type ReceiptDecision = { send: true } | { send: false; reason: ReceiptSkipReason };

export type ReactionTemplate = { kind: number; tags: string[][]; content: string };

export type PublishResult = { ok: boolean; id: string; message: string };

export type PublishFn = (template: ReactionTemplate, timeoutMs: number) => Promise<PublishResult>;

export type LedgerRecord =
  | { state: "pending"; author: string; channel: string; kind: number }
  | { state: "done" }
  | { state: "gave_up" };

export function isSettled(record: LedgerRecord | undefined): boolean {
  return record?.state === "done" || record?.state === "gave_up";
}

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.trim().toLowerCase();
  if (!HEX64.test(h)) throw new Error("invalid hex secret key");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** nsec bech32 or 64-char hex. Errors never embed the input. */
export function parseSecretKey(input: string): Uint8Array {
  const trimmed = input.trim();
  if (trimmed.startsWith("nsec1")) {
    let decoded: ReturnType<typeof nip19.decode>;
    try {
      decoded = nip19.decode(trimmed);
    } catch {
      throw new Error("invalid nsec secret key");
    }
    if (decoded.type !== "nsec") throw new Error("expected an nsec");
    return decoded.data as Uint8Array;
  }
  return hexToBytes(trimmed);
}

export function pubkeyOf(secret: Uint8Array): string {
  return getPublicKey(secret);
}

/**
 * NIP-25 kind:7 plus the channel `h` tag so the reaction sits in the same
 * group as the wake. Production only calls this when author and channel are
 * both present; omitting them here is for the unit test of the template.
 */
export function buildReactionTemplate(opts: {
  eventId: string;
  reaction: string;
  author?: string;
  channel?: string;
  kind?: number;
}): ReactionTemplate {
  const tags: string[][] = [["e", opts.eventId.toLowerCase()]];
  if (opts.author && HEX64.test(opts.author)) tags.push(["p", opts.author.toLowerCase()]);
  if (opts.channel) tags.push(["h", opts.channel]);
  if (typeof opts.kind === "number") tags.push(["k", String(opts.kind)]);
  return { kind: KIND_REACTION, tags, content: opts.reaction };
}

export function decideReceipt(input: {
  enabled: boolean;
  delivered: boolean;
  eventId: string;
  author: string;
  channel: string;
  source: EventSource;
  /** When omitted, the own-message check is skipped — caller reads the key later. */
  ownPubkey?: string;
  seen: boolean;
}): ReceiptDecision {
  if (!input.enabled) return { send: false, reason: "disabled" };
  if (!input.delivered) return { send: false, reason: "not-delivered" };
  if (input.source === "synthetic") return { send: false, reason: "synthetic" };
  if (!HEX64.test(input.eventId)) return { send: false, reason: "no-event" };
  if (!HEX64.test(input.author) || !input.channel.trim()) return { send: false, reason: "no-scope" };
  if (input.seen) return { send: false, reason: "seen" };
  if (input.ownPubkey && input.author.toLowerCase() === input.ownPubkey.toLowerCase()) {
    return { send: false, reason: "own" };
  }
  return { send: true };
}

export function seenPath(stateDir: string): string {
  return join(stateDir, DEFAULT_RECEIPT_SEEN_NAME);
}

export function parseLedgerLine(line: string): { id: string; record: LedgerRecord } | undefined {
  const t = line.trim();
  if (!t) return undefined;
  const pending = t.match(/^pending\s+([0-9a-f]{64})\s+([0-9a-f]{64})\s+(\S+)\s+(\d+)$/i);
  if (pending?.[1] && pending[2] && pending[3]) {
    return {
      id: pending[1].toLowerCase(),
      record: { state: "pending", author: pending[2].toLowerCase(), channel: pending[3], kind: Number.parseInt(pending[4] ?? "9", 10) },
    };
  }
  const gaveUp = t.match(/^gave_up\s+([0-9a-f]{64})$/i);
  if (gaveUp?.[1]) return { id: gaveUp[1].toLowerCase(), record: { state: "gave_up" } };
  const done = t.match(/^done\s+([0-9a-f]{64})$/i);
  if (done?.[1]) return { id: done[1].toLowerCase(), record: { state: "done" } };
  // Legacy one-id-per-line files from the first PR revision.
  if (HEX64.test(t)) return { id: t.toLowerCase(), record: { state: "done" } };
  return undefined;
}

export function formatLedgerLine(id: string, record: LedgerRecord): string {
  if (record.state === "pending") return `pending ${id} ${record.author} ${record.channel} ${record.kind}`;
  if (record.state === "gave_up") return `gave_up ${id}`;
  return `done ${id}`;
}

/** Drop the oldest settled (done/gave_up) rows until size <= maxSeen. Never evicts pending. */
export function evictSettled(records: Map<string, LedgerRecord>, maxSeen: number): void {
  while (records.size > maxSeen) {
    let evicted = false;
    for (const [id, rec] of records) {
      if (rec.state === "pending") continue;
      records.delete(id);
      evicted = true;
      break;
    }
    if (!evicted) break;
  }
}

/** Keep `id` as the newest entry; drop the oldest settled row when over `maxSeen`. */
export function touchRecord(records: Map<string, LedgerRecord>, id: string, record: LedgerRecord, maxSeen: number): void {
  if (records.has(id)) records.delete(id);
  records.set(id, record);
  evictSettled(records, maxSeen);
}

/** Stream the file so a huge ledger cannot be loaded whole into a Set. ENOENT is empty; any other read error throws. */
export async function loadLedger(path: string, maxSeen: number): Promise<Map<string, LedgerRecord>> {
  const records = new Map<string, LedgerRecord>();
  try {
    accessSync(path, constants.R_OK);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return records;
    throw err;
  }
  const stream = createReadStream(path, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const parsed = parseLedgerLine(line);
      if (parsed) touchRecord(records, parsed.id, parsed.record, maxSeen);
    }
  } catch (err) {
    stream.destroy();
    throw err;
  } finally {
    rl.close();
    stream.destroy();
  }
  return records;
}

function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
}

export function writeLedger(path: string, records: Map<string, LedgerRecord>): void {
  const lines: string[] = [];
  for (const [id, rec] of records) lines.push(formatLedgerLine(id, rec));
  writeFileAtomic(path, lines.length ? lines.join("\n") + "\n" : "");
}

function isAuthRequired(message: string): boolean {
  return message.toLowerCase().includes("auth-required");
}

/**
 * One-shot NIP-01 publish: connect, AUTH if challenged, EVENT, wait for OK,
 * close. A late `auth-required` OK or a challenge after the first EVENT
 * authenticates and resends once. The whole attempt is bounded by `timeoutMs`.
 * Never logs — the caller emits the single warning.
 */
export async function publishToRelay(opts: {
  url: string;
  secretKey: Uint8Array;
  template: ReactionTemplate;
  timeoutMs: number;
}): Promise<PublishResult> {
  const signed = finalizeEvent(
    {
      kind: opts.template.kind,
      tags: opts.template.tags,
      content: opts.template.content,
      created_at: Math.floor(Date.now() / 1000),
    },
    opts.secretKey,
  );
  const deadline = Date.now() + opts.timeoutMs;
  const remain = () => Math.max(1, deadline - Date.now());

  return new Promise<PublishResult>((resolve) => {
    let settled = false;
    let ws: WebSocket | undefined;
    let authSent = false;
    let authEventId: string | undefined;
    let eventSends = 0;
    let challenge: string | undefined;
    let authWait: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: PublishResult) => {
      if (settled) return;
      settled = true;
      if (authWait) clearTimeout(authWait);
      clearTimeout(overall);
      try {
        ws?.close();
      } catch {
        // already gone
      }
      resolve(result);
    };
    const overall = setTimeout(() => finish({ ok: false, id: signed.id, message: "timeout" }), opts.timeoutMs);

    const sendJson = (msg: unknown): boolean => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      try {
        ws.send(JSON.stringify(msg));
        return true;
      } catch {
        return false;
      }
    };

    const sendEvent = () => {
      if (settled || eventSends >= 2) return;
      eventSends++;
      if (!sendJson(["EVENT", signed])) {
        finish({ ok: false, id: signed.id, message: "not connected" });
      }
    };

    const sendAuth = (ch: string) => {
      if (authSent || settled) return;
      authSent = true;
      const auth = finalizeEvent(
        {
          kind: KIND_AUTH,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["relay", opts.url],
            ["challenge", ch],
          ],
          content: "",
        },
        opts.secretKey,
      );
      authEventId = auth.id;
      if (!sendJson(["AUTH", auth])) {
        finish({ ok: false, id: signed.id, message: "auth send failed" });
      }
    };

    try {
      ws = new WebSocket(opts.url);
    } catch (err) {
      finish({ ok: false, id: signed.id, message: errMessage(err) });
      return;
    }

    ws.addEventListener("open", () => {
      // Open relays never AUTH; wait a beat, then publish. A challenge
      // arriving first cancels the beat so EVENT never races AUTH.
      const beat = Math.min(1500, Math.max(50, Math.floor(remain() / 3)));
      authWait = setTimeout(() => {
        if (!challenge) sendEvent();
      }, beat);
    });

    ws.addEventListener("message", (ev) => {
      let msg: unknown;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (!Array.isArray(msg) || typeof msg[0] !== "string") return;
      const type = msg[0];
      if (type === "AUTH") {
        const ch = typeof msg[1] === "string" ? msg[1] : "";
        if (!ch) return;
        challenge = ch;
        if (authWait) {
          clearTimeout(authWait);
          authWait = undefined;
        }
        sendAuth(ch);
        return;
      }
      if (type === "OK") {
        const id = String(msg[1] ?? "");
        const ok = msg[2] === true;
        const message = typeof msg[3] === "string" ? msg[3] : "";
        if (authEventId && id === authEventId) {
          if (!ok) {
            finish({ ok: false, id: signed.id, message: message || "auth rejected" });
            return;
          }
          sendEvent();
          return;
        }
        if (id !== signed.id) return;
        if (ok) {
          finish({ ok: true, id: signed.id, message: "" });
          return;
        }
        if (isAuthRequired(message) && eventSends < 2) {
          if (challenge) sendAuth(challenge);
          return;
        }
        finish({ ok: false, id: signed.id, message: message || "rejected" });
      }
    });

    ws.addEventListener("error", () => {
      if (!settled) finish({ ok: false, id: signed.id, message: "websocket error" });
    });
    ws.addEventListener("close", () => {
      if (!settled) finish({ ok: false, id: signed.id, message: "connection closed" });
    });
  });
}

export type ReceiptsOptions = {
  enabled: boolean;
  reaction: string;
  timeoutMs: number;
  stateDir: string;
  relayUrl: string;
  maxSeen?: number;
  /**
   * Harness-injected secret, or a getter that reads it at publish time.
   * Ignored when receipts are disabled — the key is not parsed or held.
   */
  secret?: string | (() => string | undefined);
  publish?: PublishFn;
};

export class Receipts {
  private readonly enabled: boolean;
  private readonly reaction: string;
  private readonly timeoutMs: number;
  private readonly relayUrl: string;
  private readonly maxSeen: number;
  private readonly seenFile: string;
  private readonly secretOpt: string | (() => string | undefined) | undefined;
  private readonly publishFn: PublishFn | undefined;
  private records = new Map<string, LedgerRecord>();
  /** Ids already attempted this process (pending or done), so we do not loop. */
  private readonly attempted = new Set<string>();
  private cachedPubkey: string | undefined;
  private persistFailed = false;
  readonly ready: Promise<void>;

  constructor(opts: ReceiptsOptions) {
    this.enabled = opts.enabled;
    this.reaction = opts.reaction;
    this.timeoutMs = opts.timeoutMs;
    this.relayUrl = opts.relayUrl.trim();
    this.maxSeen = opts.maxSeen ?? DEFAULT_RECEIPT_MAX_SEEN;
    this.seenFile = seenPath(opts.stateDir);
    this.secretOpt = this.enabled ? opts.secret : undefined;
    this.publishFn = opts.publish;
    this.ready = this.enabled ? this.init() : Promise.resolve();
  }

  get pubkey(): string {
    if (!this.enabled) return "";
    if (this.cachedPubkey !== undefined) return this.cachedPubkey;
    const sk = this.parseSecret();
    this.cachedPubkey = sk ? pubkeyOf(sk) : "";
    return this.cachedPubkey;
  }

  /** Never throws. A failed receipt logs exactly one warning. */
  async afterDelivery(delivery: Delivery, delivered: boolean): Promise<void> {
    let warning: string | undefined;
    try {
      await this.ready;
      warning = await this.run(delivery, delivered);
    } catch (err) {
      warning = `receipt failed: ${errMessage(err)}`;
    }
    if (warning) log.warn(warning);
  }

  private async init(): Promise<void> {
    try {
      const existed = existsSync(this.seenFile);
      this.records = await loadLedger(this.seenFile, this.maxSeen);
      if (existed) this.persist(this.records);
    } catch (err) {
      this.disablePersist(`receipt: ledger unusable (${errMessage(err)}); receipts off`);
      return;
    }
    await this.retryPending();
  }

  private async retryPending(): Promise<void> {
    if (this.persistFailed || !this.enabled) return;
    const pending: { id: string; author: string; channel: string; kind: number }[] = [];
    for (const [id, rec] of this.records) {
      if (rec.state === "pending") pending.push({ id, author: rec.author, channel: rec.channel, kind: rec.kind });
    }
    for (const p of pending) {
      if (this.attempted.has(p.id)) continue;
      const warning = await this.publishRecord(p.id, p.author, p.channel, p.kind, true);
      if (warning) log.warn(warning);
    }
  }

  private async run(delivery: Delivery, delivered: boolean): Promise<string | undefined> {
    if (!this.enabled || this.persistFailed) return undefined;
    const eventId = delivery.event.id.toLowerCase();
    const decision = decideReceipt({
      enabled: this.enabled,
      delivered,
      eventId,
      author: delivery.event.pubkey,
      channel: delivery.channel,
      source: delivery.source,
      seen: this.attempted.has(eventId) || isSettled(this.records.get(eventId)),
    });
    if (!decision.send) return undefined;
    const ownPubkey = this.pubkey;
    if (ownPubkey && delivery.event.pubkey.toLowerCase() === ownPubkey.toLowerCase()) return undefined;
    return this.publishRecord(eventId, delivery.event.pubkey.toLowerCase(), delivery.channel, delivery.event.kind, false);
  }

  private async publishRecord(eventId: string, author: string, channel: string, kind: number, startupRetry = false): Promise<string | undefined> {
    if (!this.publishFn) {
      if (!this.parseSecret()) return "receipt: no harness key";
      if (!this.relayUrl) return "receipt: no relay";
    }
    this.attempted.add(eventId);
    const pending: LedgerRecord = { state: "pending", author, channel, kind };
    touchRecord(this.records, eventId, pending, this.maxSeen);
    try {
      this.persist(this.records);
    } catch (err) {
      this.disablePersist(`receipt: could not record pending id (${errMessage(err)}); receipts off`);
      return undefined;
    }

    const template = buildReactionTemplate({ eventId, reaction: this.reaction, author, channel, kind });
    const result = await this.publish(template, this.timeoutMs);
    if (!result.ok) {
      if (startupRetry) {
        touchRecord(this.records, eventId, { state: "gave_up" }, this.maxSeen);
        try {
          this.persist(this.records);
        } catch (err) {
          this.disablePersist(`receipt: could not record gave_up (${errMessage(err)}); receipts off`);
          return undefined;
        }
        return `receipt: publish failed (${result.message || "error"}); giving up`;
      }
      return `receipt: publish failed (${result.message || "error"})`;
    }
    touchRecord(this.records, eventId, { state: "done" }, this.maxSeen);
    try {
      this.persist(this.records);
    } catch (err) {
      // Already published. Leave pending on disk so a restart retries (at-least-once).
      return `receipt: published but could not record done (${errMessage(err)})`;
    }
    log.info("receipt published", { event: eventId, reaction: this.reaction });
    return undefined;
  }

  private persist(records: Map<string, LedgerRecord>): void {
    writeLedger(this.seenFile, records);
  }

  private disablePersist(message: string): void {
    if (this.persistFailed) return;
    this.persistFailed = true;
    log.warn(message);
  }

  private readSecret(): string | undefined {
    if (!this.enabled) return undefined;
    const v = typeof this.secretOpt === "function" ? this.secretOpt() : this.secretOpt;
    const t = v?.trim();
    return t || undefined;
  }

  private parseSecret(): Uint8Array | undefined {
    const raw = this.readSecret();
    if (!raw) return undefined;
    try {
      return parseSecretKey(raw);
    } catch {
      return undefined;
    }
  }

  private publish(template: ReactionTemplate, timeoutMs: number): Promise<PublishResult> {
    if (this.publishFn) return this.publishFn(template, timeoutMs);
    const sk = this.parseSecret();
    if (!sk) return Promise.resolve({ ok: false, id: "", message: "no-key" });
    if (!this.relayUrl) return Promise.resolve({ ok: false, id: "", message: "no-relay" });
    return publishToRelay({ url: this.relayUrl, secretKey: sk, template, timeoutMs });
  }
}
