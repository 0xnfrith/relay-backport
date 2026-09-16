// webhook sink: POST the delivery as JSON. Retries with backoff on network
// errors and 5xx/429; a 4xx is final; a timeout is final too, because the
// server may already have acted on the request (at-least-once, so the
// receiver must be idempotent on `event_id`).
//
// In `cumulative` thread-context mode it also keeps a per-session ledger of
// the `<thread-context>` blocks the harness has sent, and carries the whole
// accumulation in `thread_context_cumulative` — see src/thread-context.ts for
// why a stateless receiver needs that and a long-lived agent does not.
import { readFileSync } from "node:fs";
import type { WebhookConfig } from "../config";
import { buildPayload, type Delivery } from "../delivery";
import { log, registerSecret } from "../log";
import { extractThreadContext, ThreadContextLedger } from "../thread-context";
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
  private readonly ledger: ThreadContextLedger | undefined;

  constructor(
    private readonly cfg: WebhookConfig,
    readFile: (path: string) => string = (p) => readFileSync(p, "utf8"),
    opts: { sleep?: (ms: number) => Promise<void>; fetchImpl?: typeof fetch; stateDir?: string; ledger?: ThreadContextLedger } = {},
  ) {
    if (cfg.threadContext === "cumulative") {
      this.ledger = opts.ledger ?? new ThreadContextLedger(opts.stateDir ?? ".", cfg.cumulativeMaxChars);
    }
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

  /**
   * The payload for one delivery. In `cumulative` mode the block this prompt
   * carries is recorded FIRST, so the field always includes the current turn's
   * context: one field the receiver can take whole, rather than one it has to
   * splice onto `prompt` itself.
   */
  payloadFor(delivery: Delivery) {
    if (!this.ledger) return buildPayload(delivery, { includeSystemPrompt: this.cfg.includeSystemPrompt });
    const sessionId = delivery.session.id;
    const block = extractThreadContext(delivery.prompt);
    if (block) this.ledger.append(sessionId, { event_id: delivery.event.id, at: delivery.receivedAt, text: block });
    const acc = this.ledger.accumulated(sessionId);
    return buildPayload(delivery, {
      includeSystemPrompt: this.cfg.includeSystemPrompt,
      threadContextCumulative: acc.text || undefined,
      threadContextTruncated: acc.truncated,
    });
  }

  async deliver(delivery: Delivery): Promise<boolean> {
    const body = JSON.stringify(this.payloadFor(delivery));
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
