// webhook sink: POST the delivery as JSON. Retries with backoff on network
// errors and 5xx/429; a 4xx is final; a timeout is final too, because the
// server may already have acted on the request (at-least-once, so the
// receiver must be idempotent on `event_id`).
import { readFileSync } from "node:fs";
import type { WebhookConfig } from "../config";
import { buildPayload, type Delivery } from "../delivery";
import { log, registerSecret } from "../log";
import type { Sink } from "./index";

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
  private fetchImpl: typeof fetch = fetch;

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

  headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.bearer) h.authorization = `Bearer ${this.bearer}`;
    return h;
  }

  async deliver(delivery: Delivery): Promise<boolean> {
    const body = JSON.stringify(buildPayload(delivery));
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
          log.info("webhook delivered", { event: delivery.event.id, status, latency_ms: Date.now() - started, attempt });
          return true;
        }
        retry = isRetryableStatus(res.status);
      } catch (err) {
        retry = isRetryableError(err);
        status = retry ? "network_error" : "timeout";
      }
      log.warn("webhook attempt failed", { event: delivery.event.id, status, latency_ms: Date.now() - started, attempt });
      if (!retry || attempt === this.cfg.attempts) return false;
      await this.sleep(backoffMs(attempt));
    }
    return false;
  }
}
