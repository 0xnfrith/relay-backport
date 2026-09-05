// exec sink: spawn a command per mention with the JSON payload on stdin.
// Concurrency 1 (mentions are handled in arrival order), hard timeout, and
// exit code 0 means accepted. The command's stdout/stderr go to our stderr so
// the daemon's own stdout contract stays clean.
import type { ExecConfig } from "../config";
import { log, errMessage } from "../log";
import type { MentionRecord } from "../mention";
import { buildWebhookPayload } from "./webhook";
import type { Sink } from "./index";

export class ExecSink implements Sink {
  readonly name = "exec";
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly cfg: ExecConfig) {}

  deliver(record: MentionRecord): Promise<boolean> {
    const run = this.queue.then(() => this.runOne(record)).catch(() => false);
    this.queue = run;
    return run;
  }

  private async runOne(record: MentionRecord): Promise<boolean> {
    const payload = JSON.stringify(buildWebhookPayload(record));
    const started = Date.now();
    let proc: Bun.Subprocess<"pipe", "inherit", "inherit">;
    try {
      proc = Bun.spawn(this.cfg.command, {
        stdin: "pipe" as const,
        stdout: "inherit" as const,
        stderr: "inherit" as const,
        env: {
          ...process.env,
          RELAY_BACKPORT_EVENT_ID: record.event.id,
          RELAY_BACKPORT_CHANNEL: record.channel,
          RELAY_BACKPORT_AUTHOR: record.event.pubkey,
          RELAY_BACKPORT_KIND: String(record.event.kind),
          RELAY_BACKPORT_RELAY: record.relay,
        },
      });
    } catch (err) {
      log.error("exec spawn failed", { event: record.event.id, error: errMessage(err) });
      return false;
    }
    try {
      const stdin = proc.stdin as Bun.FileSink;
      stdin.write(payload + "\n");
      await stdin.end();
    } catch {
      // the command may exit without reading stdin
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill();
      } catch {
        // ignore
      }
    }, this.cfg.timeoutMs);
    const code = await proc.exited;
    clearTimeout(timer);
    const latency = Date.now() - started;
    if (timedOut) {
      log.warn("exec timed out", { event: record.event.id, latency_ms: latency });
      return false;
    }
    if (code !== 0) {
      log.warn("exec exited non-zero", { event: record.event.id, code, latency_ms: latency });
      return false;
    }
    log.info("exec delivered", { event: record.event.id, latency_ms: latency });
    return true;
  }
}
