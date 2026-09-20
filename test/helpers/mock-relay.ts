// A small NIP-01 relay for tests: optional NIP-42 AUTH and EVENT → OK.
import { verifyEvent, type Event } from "nostr-tools";

type Conn = { authed: boolean; challenge: string };

export type MockRelayOptions = {
  requireAuth?: boolean;
  /** Reject the first EVENT with auth-required and send the AUTH challenge then; accept after AUTH. */
  lateAuth?: boolean;
  /**
   * Challenge on the first EVENT without an OK, then after AUTH and the resend
   * emit a delayed auth-required OK for that same event id before accepting.
   */
  delayedAuthReject?: boolean;
  rejectPublish?: string;
};

export class MockRelay {
  readonly published: Event[] = [];
  readonly authAttempts: { pubkey: string; ok: boolean }[] = [];
  readonly eventAttempts: Event[] = [];
  readonly server: ReturnType<typeof Bun.serve<Conn>>;
  private seq = 0;

  constructor(readonly opts: MockRelayOptions = {}) {
    const self = this;
    this.server = Bun.serve<Conn>({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, server) {
        if (server.upgrade(req, { data: { authed: false, challenge: "" } })) return undefined;
        return new Response("not found", { status: 404 });
      },
      websocket: {
        open(ws) {
          if (self.opts.requireAuth) {
            ws.data.challenge = `challenge-${++self.seq}`;
            ws.send(JSON.stringify(["AUTH", ws.data.challenge]));
          }
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
            const ok = ev.kind === 22242 && tagChallenge === conn.challenge && verifyEvent(ev);
            conn.authed = ok;
            self.authAttempts.push({ pubkey: ev.pubkey, ok });
            ws.send(JSON.stringify(["OK", ev.id, ok, ok ? "" : "auth-required"]));
            return;
          }
          if (msg[0] === "EVENT") {
            const ev = msg[1] as Event;
            self.eventAttempts.push(ev);
            if (self.opts.delayedAuthReject && !conn.authed) {
              if (!conn.challenge) {
                conn.challenge = `challenge-${++self.seq}`;
                ws.send(JSON.stringify(["AUTH", conn.challenge]));
              }
              return;
            }
            if (self.opts.delayedAuthReject && conn.authed) {
              ws.send(JSON.stringify(["OK", ev.id, false, "auth-required: authenticate first"]));
              if (!verifyEvent(ev)) {
                ws.send(JSON.stringify(["OK", ev.id, false, "invalid: bad signature"]));
                return;
              }
              self.published.push(ev);
              ws.send(JSON.stringify(["OK", ev.id, true, ""]));
              return;
            }
            if ((self.opts.requireAuth || self.opts.lateAuth) && !conn.authed) {
              if (self.opts.lateAuth && !conn.challenge) {
                conn.challenge = `challenge-${++self.seq}`;
                ws.send(JSON.stringify(["OK", ev.id, false, "auth-required: authenticate first"]));
                ws.send(JSON.stringify(["AUTH", conn.challenge]));
                return;
              }
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
          }
        },
      },
    });
  }

  get url(): string {
    return `ws://127.0.0.1:${this.server.port}`;
  }

  stop(): void {
    this.server.stop(true);
  }
}
