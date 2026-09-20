// Delivery receipt: a kind:7 reaction on the event that woke us, signed by
// the harness identity, so the author can see the wake was received even
// while the consumer behind the sinks is still working.
//
// There is no other publish path in this process — the harness owns the
// long-lived relay socket. When receipts are on, we open a one-shot NIP-01
// websocket to the same URL, answer NIP-42 AUTH if the relay asks, publish
// the reaction, and close. Failure is a single warning; delivery already
// happened and is never rolled back.
//
// Off by default. Fires at most once per event id (persisted under the
// state dir so a restart or a harness replay does not react twice).
import { closeSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { finalizeEvent, getPublicKey, nip19 } from "nostr-tools";
import { DEFAULT_RECEIPT_SEEN_NAME } from "./config";
import type { Delivery } from "./delivery";
import { log, errMessage } from "./log";

export const KIND_REACTION = 7;
export const KIND_AUTH = 22242;

const HEX64 = /^[0-9a-f]{64}$/i;

export type ReceiptSkipReason = "disabled" | "not-delivered" | "own" | "seen" | "no-event" | "no-key" | "no-relay";

export type ReceiptDecision = { send: true } | { send: false; reason: ReceiptSkipReason };

export type ReactionTemplate = { kind: number; tags: string[][]; content: string };

export type PublishResult = { ok: boolean; id: string; message: string };

export type PublishFn = (template: ReactionTemplate, timeoutMs: number) => Promise<PublishResult>;

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
 * group as the wake. `p` and `k` are omitted when the delivery did not carry
 * an author or a kind.
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
  ownPubkey: string;
  seen: boolean;
}): ReceiptDecision {
  if (!input.enabled) return { send: false, reason: "disabled" };
  if (!input.delivered) return { send: false, reason: "not-delivered" };
  if (!HEX64.test(input.eventId)) return { send: false, reason: "no-event" };
  if (input.seen) return { send: false, reason: "seen" };
  if (input.ownPubkey && input.author && input.author.toLowerCase() === input.ownPubkey.toLowerCase()) {
    return { send: false, reason: "own" };
  }
  return { send: true };
}

export function seenPath(stateDir: string): string {
  return join(stateDir, DEFAULT_RECEIPT_SEEN_NAME);
}

/** One event id per line. A missing or unreadable file is an empty set. */
export function loadSeen(path: string): Set<string> {
  try {
    const text = readFileSync(path, "utf8");
    const out = new Set<string>();
    for (const line of text.split("\n")) {
      const id = line.trim().toLowerCase();
      if (HEX64.test(id)) out.add(id);
    }
    return out;
  } catch {
    return new Set();
  }
}

export function appendSeen(path: string, eventId: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, "a", 0o600);
  try {
    writeSync(fd, eventId.toLowerCase() + "\n");
  } finally {
    closeSync(fd);
  }
}

/**
 * One-shot NIP-01 publish: connect, AUTH if challenged, EVENT, wait for OK,
 * close. The whole attempt is bounded by `timeoutMs`.
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
    let eventSent = false;
    let challenged = false;
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
      } catch (err) {
        log.warn("receipt send failed", { error: errMessage(err) });
        return false;
      }
    };

    const sendEvent = () => {
      if (eventSent || settled) return;
      eventSent = true;
      if (!sendJson(["EVENT", signed])) {
        finish({ ok: false, id: signed.id, message: "not connected" });
      }
    };

    const sendAuth = (challenge: string) => {
      if (authSent) return;
      authSent = true;
      const auth = finalizeEvent(
        {
          kind: KIND_AUTH,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["relay", opts.url],
            ["challenge", challenge],
          ],
          content: "",
        },
        opts.secretKey,
      );
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
        if (!challenged) sendEvent();
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
        const challenge = typeof msg[1] === "string" ? msg[1] : "";
        if (!challenge) return;
        challenged = true;
        if (authWait) {
          clearTimeout(authWait);
          authWait = undefined;
        }
        sendAuth(challenge);
        return;
      }
      if (type === "OK") {
        const id = String(msg[1] ?? "");
        const ok = msg[2] === true;
        const message = typeof msg[3] === "string" ? msg[3] : "";
        if (!eventSent) {
          // AUTH result (or a stray OK). Only proceed on success.
          if (!ok) {
            finish({ ok: false, id: signed.id, message: message || "auth rejected" });
            return;
          }
          sendEvent();
          return;
        }
        if (id === signed.id) finish({ ok, id: signed.id, message: ok ? "" : message || "rejected" });
        return;
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
  /** Harness-injected secret; never logged. */
  secret?: string;
  publish?: PublishFn;
};

export class Receipts {
  private readonly enabled: boolean;
  private readonly reaction: string;
  private readonly timeoutMs: number;
  private readonly relayUrl: string;
  private readonly seenFile: string;
  private readonly seen: Set<string>;
  private readonly secretKey: Uint8Array | undefined;
  private readonly ownPubkey: string;
  private readonly publish: PublishFn;

  constructor(opts: ReceiptsOptions) {
    this.enabled = opts.enabled;
    this.reaction = opts.reaction;
    this.timeoutMs = opts.timeoutMs;
    this.relayUrl = opts.relayUrl.trim();
    this.seenFile = seenPath(opts.stateDir);
    this.seen = this.enabled ? loadSeen(this.seenFile) : new Set();
    if (opts.secret) {
      try {
        this.secretKey = parseSecretKey(opts.secret);
        this.ownPubkey = pubkeyOf(this.secretKey);
      } catch {
        this.secretKey = undefined;
        this.ownPubkey = "";
        if (this.enabled) log.warn("receipt: harness key is not a usable secret; receipts will not fire");
      }
    } else {
      this.ownPubkey = "";
      if (this.enabled) log.warn("receipt: no harness key in the environment; receipts will not fire");
    }
    this.publish =
      opts.publish ??
      ((template, timeoutMs) => {
        if (!this.secretKey) return Promise.resolve({ ok: false, id: "", message: "no-key" });
        if (!this.relayUrl) return Promise.resolve({ ok: false, id: "", message: "no-relay" });
        return publishToRelay({ url: this.relayUrl, secretKey: this.secretKey, template, timeoutMs });
      });
  }

  get pubkey(): string {
    return this.ownPubkey;
  }

  /** Never throws. A failed publish logs one warning and returns. */
  async afterDelivery(delivery: Delivery, delivered: boolean): Promise<void> {
    try {
      await this.run(delivery, delivered);
    } catch (err) {
      log.warn("receipt failed", { error: errMessage(err) });
    }
  }

  private async run(delivery: Delivery, delivered: boolean): Promise<void> {
    if (!this.enabled) return;
    if (!this.secretKey || !this.relayUrl) return;
    const eventId = delivery.event.id.toLowerCase();
    const decision = decideReceipt({
      enabled: this.enabled,
      delivered,
      eventId,
      author: delivery.event.pubkey,
      ownPubkey: this.ownPubkey,
      seen: this.seen.has(eventId),
    });
    if (!decision.send) return;

    this.seen.add(eventId);
    try {
      appendSeen(this.seenFile, eventId);
    } catch (err) {
      log.warn("receipt: could not persist seen id", { error: errMessage(err) });
    }

    const template = buildReactionTemplate({
      eventId,
      reaction: this.reaction,
      author: delivery.event.pubkey,
      channel: delivery.channel,
      kind: delivery.event.kind,
    });
    const result = await this.publish(template, this.timeoutMs);
    if (!result.ok) {
      log.warn("receipt: publish failed", { event: eventId, error: result.message || "error" });
      return;
    }
    log.info("receipt published", { event: eventId, reaction: this.reaction });
  }
}
