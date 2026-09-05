// A small NIP-01 relay on Bun.serve for tests: optional NIP-42 auth, stored
// events served on REQ, live fan-out on publish, EVENT acceptance with OK,
// and a record of every REQ so tests can assert on subscriptions.
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools";
import type { Event, EventTemplate, Filter } from "nostr-tools";
import { matchFilter } from "nostr-tools/filter";
import type { ServerWebSocket } from "bun";

export type Req = { id: string; filters: Filter[]; authed: boolean };

type Conn = { authed: boolean; challenge: string; subs: Map<string, Filter[]> };

export type MockRelayOptions = {
  requireAuth?: boolean;
  /** Only these pubkeys may authenticate; others get OK false. */
  allowPubkeys?: string[];
  /** Reject every published event with this message. */
  rejectPublish?: string;
  /**
   * Emulate a Buzz relay's live routing: a subscription is only pushed
   * channel-addressed events when its filters resolve to exactly ONE channel.
   * A REQ whose `#h` names several channels (or none) still replays stored
   * events and gets its EOSE, but never receives a live push. Off by default.
   */
  singleChannelFanOut?: boolean;
};

/** The channel a REQ resolves to, or undefined when it is not single-channel. */
function soleChannel(filters: Filter[]): string | undefined {
  const ids = new Set<string>();
  for (const f of filters) {
    const values = (f as Filter & { "#h"?: string[] })["#h"];
    if (!values || values.length === 0) return undefined;
    for (const v of values) ids.add(v);
  }
  return ids.size === 1 ? [...ids][0] : undefined;
}

export class MockRelay {
  readonly events: Event[] = [];
  readonly reqs: Req[] = [];
  readonly published: Event[] = [];
  readonly authAttempts: { pubkey: string; ok: boolean }[] = [];
  private readonly conns = new Map<ServerWebSocket<Conn>, Conn>();
  readonly server: ReturnType<typeof Bun.serve<Conn>>;
  private seq = 0;

  constructor(readonly opts: MockRelayOptions = {}) {
    const self = this;
    this.server = Bun.serve<Conn>({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, server) {
        if (server.upgrade(req, { data: { authed: false, challenge: "", subs: new Map() } })) return undefined;
        return new Response("not found", { status: 404 });
      },
      websocket: {
        open(ws) {
          self.conns.set(ws, ws.data);
          if (self.opts.requireAuth) {
            ws.data.challenge = `challenge-${++self.seq}-${Math.random().toString(36).slice(2)}`;
            ws.send(JSON.stringify(["AUTH", ws.data.challenge]));
          }
        },
        close(ws) {
          self.conns.delete(ws);
        },
        message(ws, raw) {
          let msg: unknown;
          try {
            msg = JSON.parse(String(raw));
          } catch {
            return;
          }
          if (!Array.isArray(msg) || typeof msg[0] !== "string") return;
          const conn = ws.data;
          if (msg[0] === "AUTH") {
            const ev = msg[1] as Event;
            const tagChallenge = ev.tags?.find((t) => t[0] === "challenge")?.[1];
            let ok = ev.kind === 22242 && tagChallenge === conn.challenge && verifyEvent(ev);
            if (ok && self.opts.allowPubkeys && !self.opts.allowPubkeys.includes(ev.pubkey)) ok = false;
            conn.authed = ok;
            self.authAttempts.push({ pubkey: ev.pubkey, ok });
            ws.send(JSON.stringify(["OK", ev.id, ok, ok ? "" : "auth-required: not on the allowlist"]));
            return;
          }
          if (msg[0] === "REQ") {
            const id = String(msg[1]);
            const filters = msg.slice(2) as Filter[];
            self.reqs.push({ id, filters, authed: conn.authed });
            if (self.opts.requireAuth && !conn.authed) {
              ws.send(JSON.stringify(["CLOSED", id, "auth-required: authenticate first"]));
              return;
            }
            conn.subs.set(id, filters);
            for (const event of self.events) {
              if (filters.some((f) => matchFilter(f, event))) ws.send(JSON.stringify(["EVENT", id, event]));
            }
            ws.send(JSON.stringify(["EOSE", id]));
            return;
          }
          if (msg[0] === "CLOSE") {
            conn.subs.delete(String(msg[1]));
            return;
          }
          if (msg[0] === "EVENT") {
            const ev = msg[1] as Event;
            if (self.opts.requireAuth && !conn.authed) {
              ws.send(JSON.stringify(["OK", ev.id, false, "auth-required: authenticate first"]));
              return;
            }
            if (self.opts.rejectPublish) {
              ws.send(JSON.stringify(["OK", ev.id, false, self.opts.rejectPublish]));
              return;
            }
            if (!verifyEvent(ev)) {
              ws.send(JSON.stringify(["OK", ev.id, false, "invalid: bad signature"]));
              return;
            }
            self.published.push(ev);
            ws.send(JSON.stringify(["OK", ev.id, true, ""]));
            self.publish(ev);
          }
        },
      },
    });
  }

  get url(): string {
    return `ws://127.0.0.1:${this.server.port}`;
  }

  /** Store without fan-out (history). */
  store(event: Event): void {
    this.events.push(event);
  }

  /** Store and fan out to every live subscription that matches. */
  publish(event: Event): void {
    if (!this.events.includes(event)) this.events.push(event);
    const channel = event.tags.find((t) => t[0] === "h")?.[1];
    for (const [ws, conn] of this.conns) {
      for (const [id, filters] of conn.subs) {
        if (this.opts.singleChannelFanOut && channel !== undefined && soleChannel(filters) !== channel) continue;
        if (filters.some((f) => matchFilter(f, event))) ws.send(JSON.stringify(["EVENT", id, event]));
      }
    }
  }

  /** Drop a live subscription the way a relay does, with a CLOSED reason. */
  closeSub(id: string, reason: string): void {
    for (const [ws, conn] of this.conns) {
      if (!conn.subs.delete(id)) continue;
      ws.send(JSON.stringify(["CLOSED", id, reason]));
    }
  }

  /** Every REQ whose sub id starts with `prefix`. */
  reqsWithPrefix(prefix: string): Req[] {
    return this.reqs.filter((r) => r.id.startsWith(prefix));
  }

  reqsFor(id: string): Req[] {
    return this.reqs.filter((r) => r.id === id);
  }

  lastReq(id: string): Req | undefined {
    const list = this.reqsFor(id);
    return list[list.length - 1];
  }

  /** Close every client socket (simulates a relay drop). */
  dropAll(code = 1001): void {
    for (const ws of this.conns.keys()) ws.close(code, "bye");
  }

  connections(): number {
    return this.conns.size;
  }

  stop(): void {
    this.server.stop(true);
  }
}

export function keypair(): { sk: Uint8Array; pk: string; hex: string } {
  const sk = generateSecretKey();
  return { sk, pk: getPublicKey(sk), hex: Buffer.from(sk).toString("hex") };
}

export function sign(sk: Uint8Array, tmpl: EventTemplate): Event {
  return finalizeEvent(tmpl, sk);
}

export function now(): number {
  return Math.floor(Date.now() / 1000);
}

export function channelMessage(
  sk: Uint8Array,
  channel: string,
  content: string,
  extraTags: string[][] = [],
  kind = 9,
): Event {
  return sign(sk, { kind, created_at: now(), content, tags: [["h", channel], ...extraTags] });
}

export function membersEvent(relaySk: Uint8Array, channel: string, members: string[]): Event {
  return sign(relaySk, {
    kind: 39002,
    created_at: now(),
    content: "",
    tags: [["d", channel], ...members.map((m) => ["p", m])],
  });
}

export function metadataEvent(relaySk: Uint8Array, channel: string, archived = false): Event {
  return sign(relaySk, {
    kind: 39000,
    created_at: now(),
    content: "",
    tags: [["d", channel], ["name", "test"], ...(archived ? [["archived", "true"]] : [])],
  });
}

export async function waitFor(pred: () => boolean, timeoutMs = 5000, label = "condition"): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await Bun.sleep(15);
  }
  throw new Error(`timed out waiting for ${label}`);
}

export const CHANNEL_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const CHANNEL_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
