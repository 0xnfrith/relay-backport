// Minimal NIP-01 client over Bun's native WebSocket, with NIP-42 auth,
// subscriptions, one-shot queries, publishing, and a ping watchdog.
// No reconnect logic here: the daemon owns the connection lifecycle.
import { finalizeEvent, type Event, type EventTemplate, type Filter } from "nostr-tools";
import { KIND_AUTH } from "./mention";
import { log, errMessage } from "./log";

export class ConnectError extends Error {
  readonly exitCode = 2;
}

export class AuthError extends Error {
  readonly exitCode = 3;
}

export type SubHandlers = {
  onEvent?: (event: Event) => void;
  onEose?: () => void;
  onClosed?: (reason: string) => void;
};

export type AuthResult = "authed" | "no-challenge";

export type RelayClientOptions = {
  url: string;
  secretKey: Uint8Array;
  pubkey: string;
  /** How long to wait for an AUTH challenge after open before proceeding. */
  authWaitMs?: number;
  pingIntervalMs?: number;
  staleAfterMs?: number;
  onClose?: (code: number, reason: string) => void;
  onError?: (message: string) => void;
  onNotice?: (message: string) => void;
  /** Called once auth succeeds after a late `auth-required` CLOSED. */
  onReauthed?: () => void;
};

type PendingOk = { resolve: (r: { ok: boolean; message: string }) => void; timer: ReturnType<typeof setTimeout> };

export class RelayClient {
  private ws: WebSocket | undefined;
  private readonly subs = new Map<string, { filters: Filter[]; handlers: SubHandlers }>();
  private readonly pendingOk = new Map<string, PendingOk>();
  private challenge: string | undefined;
  private authEventId: string | undefined;
  private authResolve: ((r: AuthResult) => void) | undefined;
  private authReject: ((e: Error) => void) | undefined;
  private authTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private lastPong = 0;
  private closedByUs = false;
  private seq = 0;

  connected = false;
  authed = false;
  authRequested = false;

  constructor(private readonly opts: RelayClientOptions) {}

  get url(): string {
    return this.opts.url;
  }

  /** Open the socket, run the NIP-42 handshake if the relay asks for it. */
  connect(timeoutMs = 10_000): Promise<AuthResult> {
    return new Promise<AuthResult>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        fn();
      };
      const connectTimer = setTimeout(() => {
        finish(() => {
          this.teardown();
          reject(new ConnectError("relay connect timed out"));
        });
      }, timeoutMs);

      let ws: WebSocket;
      try {
        ws = new WebSocket(this.opts.url);
      } catch (err) {
        finish(() => reject(new ConnectError(`cannot open relay socket: ${errMessage(err)}`)));
        return;
      }
      this.ws = ws;
      this.closedByUs = false;
      this.authResolve = (r) => finish(() => resolve(r));
      this.authReject = (e) => finish(() => reject(e));

      ws.onopen = () => {
        this.connected = true;
        this.lastPong = Date.now();
        this.startPing();
        // Wait a beat for the relay's AUTH challenge; an open relay never sends one.
        this.authTimer = setTimeout(() => {
          if (!this.authRequested) this.authResolve?.("no-challenge");
        }, this.opts.authWaitMs ?? 3000);
      };
      ws.onmessage = (ev) => this.onMessage(String(ev.data));
      ws.onerror = () => {
        this.opts.onError?.("socket error");
        if (!settled) finish(() => reject(new ConnectError("relay socket error")));
      };
      ws.onclose = (ev) => {
        const wasConnected = this.connected;
        this.connected = false;
        this.authed = false;
        this.stopPing();
        for (const [, p] of this.pendingOk) {
          clearTimeout(p.timer);
          p.resolve({ ok: false, message: "socket closed" });
        }
        this.pendingOk.clear();
        if (!settled) {
          finish(() =>
            reject(
              wasConnected
                ? new ConnectError(`relay closed during handshake (code ${ev.code})`)
                : new ConnectError(`relay refused connection (code ${ev.code})`),
            ),
          );
          return;
        }
        this.opts.onClose?.(ev.code, ev.reason ?? "");
      };
      ws.addEventListener("pong", () => {
        this.lastPong = Date.now();
      });
    });
  }

  private startPing(): void {
    this.stopPing();
    const interval = this.opts.pingIntervalMs ?? 25_000;
    const stale = this.opts.staleAfterMs ?? 40_000;
    this.pingTimer = setInterval(() => {
      if (!this.ws || !this.connected) return;
      if (Date.now() - this.lastPong > stale) {
        log.warn("relay watchdog: no pong, closing for reconnect");
        try {
          this.ws.close(4000, "stale");
        } catch {
          // ignore
        }
        return;
      }
      try {
        // Bun's client WebSocket exposes ping()/pong events (not in the DOM types).
        (this.ws as unknown as { ping: () => void }).ping();
      } catch {
        // ignore
      }
    }, interval);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
  }

  private teardown(): void {
    this.stopPing();
    if (this.authTimer) clearTimeout(this.authTimer);
    this.authTimer = undefined;
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    this.ws = undefined;
    this.connected = false;
    this.authed = false;
  }

  /** Close on purpose; onClose still fires (the daemon checks its own stop flag). */
  disconnect(): void {
    this.closedByUs = true;
    this.teardown();
  }

  private send(msg: unknown): boolean {
    if (!this.ws || !this.connected) return false;
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch (err) {
      log.warn("relay send failed", { error: errMessage(err) });
      return false;
    }
  }

  private sendAuth(challenge: string): void {
    const template: EventTemplate = {
      kind: KIND_AUTH,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["relay", this.opts.url],
        ["challenge", challenge],
      ],
      content: "",
    };
    const signed = finalizeEvent(template, this.opts.secretKey);
    this.authEventId = signed.id;
    this.authRequested = true;
    if (this.authTimer) clearTimeout(this.authTimer);
    this.send(["AUTH", signed]);
  }

  private onMessage(raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(msg) || typeof msg[0] !== "string") return;
    const type = msg[0];

    if (type === "AUTH") {
      const challenge = typeof msg[1] === "string" ? msg[1] : "";
      if (!challenge) return;
      this.challenge = challenge;
      this.sendAuth(challenge);
      return;
    }

    if (type === "OK") {
      const id = String(msg[1]);
      const ok = msg[2] === true;
      const message = typeof msg[3] === "string" ? msg[3] : "";
      if (id === this.authEventId) {
        this.authEventId = undefined;
        if (ok) {
          const wasAuthed = this.authed;
          this.authed = true;
          if (this.authResolve) {
            this.authResolve("authed");
            this.authResolve = undefined;
            this.authReject = undefined;
          } else if (!wasAuthed) {
            this.resendAll();
            this.opts.onReauthed?.();
          }
        } else {
          this.authed = false;
          const err = new AuthError(`relay rejected auth: ${message || "no reason"}`);
          if (this.authReject) {
            this.authReject(err);
            this.authResolve = undefined;
            this.authReject = undefined;
          } else {
            this.opts.onError?.(`auth-failed: ${message}`);
          }
        }
        return;
      }
      const pending = this.pendingOk.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingOk.delete(id);
        pending.resolve({ ok, message });
      } else if (!ok) {
        log.warn("relay rejected publish", { id, message });
      }
      return;
    }

    if (type === "EVENT") {
      const subId = String(msg[1]);
      const event = msg[2] as Event;
      if (!event || typeof event !== "object" || typeof event.id !== "string") return;
      this.subs.get(subId)?.handlers.onEvent?.(event);
      return;
    }

    if (type === "EOSE") {
      this.subs.get(String(msg[1]))?.handlers.onEose?.();
      return;
    }

    if (type === "CLOSED") {
      const subId = String(msg[1]);
      const reason = typeof msg[2] === "string" ? msg[2] : "";
      if (reason.startsWith("auth-required")) {
        if (this.challenge && !this.authed && !this.authEventId) {
          // The relay wants auth before it serves this sub; answer and resend.
          this.sendAuth(this.challenge);
          return;
        }
        if (!this.challenge) log.warn("relay requires auth but sent no challenge", { sub: subId });
      }
      this.subs.get(subId)?.handlers.onClosed?.(reason);
      return;
    }

    if (type === "NOTICE") {
      this.opts.onNotice?.(typeof msg[1] === "string" ? msg[1] : "");
    }
  }

  private resendAll(): void {
    for (const [id, sub] of this.subs) this.send(["REQ", id, ...sub.filters]);
  }

  /** Open (or replace: same id) a subscription. */
  req(id: string, filters: Filter[], handlers: SubHandlers): boolean {
    this.subs.set(id, { filters, handlers });
    return this.send(["REQ", id, ...filters]);
  }

  close(id: string): void {
    if (this.subs.delete(id)) this.send(["CLOSE", id]);
  }

  hasSub(id: string): boolean {
    return this.subs.has(id);
  }

  /** One-shot query: collect until EOSE (or timeout), then close. */
  query(filters: Filter[], timeoutMs = 8000): Promise<{ events: Event[]; eosed: boolean }> {
    return new Promise((resolve) => {
      const id = `q-${++this.seq}`;
      const events: Event[] = [];
      let settled = false;
      const finish = (eosed: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.close(id);
        resolve({ events, eosed });
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      const sent = this.req(id, filters, {
        onEvent: (e) => events.push(e),
        onEose: () => finish(true),
        onClosed: () => finish(false),
      });
      if (!sent) finish(false);
    });
  }

  /** Sign and publish; resolves with the relay's OK (or a timeout). */
  publish(
    template: { kind: number; tags: string[][]; content: string; created_at?: number },
    timeoutMs = 5000,
  ): Promise<{ ok: boolean; id: string; message: string }> {
    const signed = finalizeEvent(
      {
        kind: template.kind,
        tags: template.tags,
        content: template.content,
        created_at: template.created_at ?? Math.floor(Date.now() / 1000),
      },
      this.opts.secretKey,
    );
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingOk.delete(signed.id);
        resolve({ ok: false, id: signed.id, message: "timeout waiting for OK" });
      }, timeoutMs);
      this.pendingOk.set(signed.id, {
        resolve: (r) => resolve({ ...r, id: signed.id }),
        timer,
      });
      if (!this.send(["EVENT", signed])) {
        clearTimeout(timer);
        this.pendingOk.delete(signed.id);
        resolve({ ok: false, id: signed.id, message: "not connected" });
      }
    });
  }

  get wasClosedByUs(): boolean {
    return this.closedByUs;
  }
}

export const BACKOFF_MIN_MS = 1000;
export const BACKOFF_MAX_MS = 30_000;
export const BACKOFF_RESET_AFTER_MS = 60_000;

/** Escalate unless the connection we just lost stayed up for a while. */
export function nextBackoff(current: number, connectionUptimeMs: number): number {
  if (connectionUptimeMs >= BACKOFF_RESET_AFTER_MS) return BACKOFF_MIN_MS;
  return Math.min(Math.max(current, BACKOFF_MIN_MS) * 2, BACKOFF_MAX_MS);
}
