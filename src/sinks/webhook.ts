// webhook sink: POST the mention as JSON. Retries with backoff on network
// errors and 5xx/429; a 4xx is final; a timeout is final too, because the
// server may already have acted on the request (at-least-once, so the
// receiver must be idempotent on `event_id`).
import { readFileSync } from "node:fs";
import type { WebhookConfig } from "../config";
import { log, registerSecret } from "../log";
import type { MentionRecord } from "../mention";
import type { Sink } from "./index";

export type WebhookPayload = {
  source: "buzz";
  relay: string;
  channel: string;
  event_id: string;
  thread_root: string;
  reply_to: string;
  root_id?: string;
  author: string;
  kind: number;
  created_at: number;
  text: string;
  tags: string[][];
  mention: { ptag: boolean; text: boolean; from_owner: boolean; allowed_by: string };
};

export function buildWebhookPayload(record: MentionRecord): WebhookPayload {
  return {
    source: "buzz",
    relay: record.relay,
    channel: record.channel,
    event_id: record.event.id,
    thread_root: record.threadRoot,
    reply_to: record.event.id,
    ...(record.rootId ? { root_id: record.rootId } : {}),
    author: record.event.pubkey,
    kind: record.event.kind,
    created_at: record.event.created_at,
    text: record.event.content,
    tags: record.event.tags,
    mention: {
      ptag: record.ptag,
      text: record.text,
      from_owner: record.fromOwner,
      allowed_by: record.allowedBy,
    },
  };
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export function isRetryableError(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name !== "TimeoutError" && name !== "AbortError";
}

export function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), 10_000);
}

export class WebhookSink implements Sink {
  readonly name = "webhook";
  private readonly bearer: string | undefined;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly cfg: WebhookConfig,
    readFile: (path: string) => string = (p) => readFileSync(p, "utf8"),
    opts: { sleep?: (ms: number) => Promise<void>; fetchImpl?: typeof fetch } = {},
  ) {
    if (cfg.bearerFile) {
      let text: string;
      try {
        text = readFile(cfg.bearerFile).trim();
      } catch {
        throw new Error("cannot read webhook bearer file");
      }
      if (text) {
        registerSecret(text);
        this.bearer = text;
      }
    }
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    if (opts.fetchImpl) this.fetchImpl = opts.fetchImpl;
  }

  private fetchImpl: typeof fetch = fetch;

  headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.bearer) h.authorization = `Bearer ${this.bearer}`;
    return h;
  }

  async deliver(record: MentionRecord): Promise<boolean> {
    const body = JSON.stringify(buildWebhookPayload(record));
    const headers = this.headers();
    for (let attempt = 1; attempt <= this.cfg.attempts; attempt++) {
      const started = Date.now();
      let status: string;
      let retry = false;
      try {
        const res = await this.fetchImpl(this.cfg.url, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(this.cfg.timeoutMs),
        });
        status = String(res.status);
        if (res.ok) {
          log.info("webhook delivered", { event: record.event.id, status, latency_ms: Date.now() - started, attempt });
          return true;
        }
        retry = isRetryableStatus(res.status);
      } catch (err) {
        retry = isRetryableError(err);
        status = retry ? "network_error" : "timeout";
      }
      log.warn("webhook attempt failed", { event: record.event.id, status, latency_ms: Date.now() - started, attempt });
      if (!retry || attempt === this.cfg.attempts) return false;
      await this.sleep(backoffMs(attempt));
    }
    return false;
  }
}
