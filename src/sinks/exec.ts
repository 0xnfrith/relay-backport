// exec sink: spawn a command per delivery with the JSON payload on stdin.
// Concurrency 1 (deliveries are handled in arrival order), hard timeout, and
// exit code 0 means accepted. The command's stdout/stderr go to OUR stderr:
// stdout is the ACP stream and must stay clean.
import type { ExecConfig } from "../config";
import { buildPayload, type Delivery } from "../delivery";
import { log, errMessage } from "../log";
import type { Sink } from "./index";

/**
 * Only these variables reach a hook by default. The harness that spawned us
 * put its own identity in our environment (`BUZZ_PRIVATE_KEY`, …); that
 * crosses into a hook only when `exec.pass_buzz_env` says so.
 */
export const HOOK_ENV_PASSTHROUGH = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "TMPDIR",
  "TZ",
  // Windows
  "SystemRoot",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "COMSPEC",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
];

/** The harness-injected identity a hook needs to call the `buzz` CLI as the agent. */
export const BUZZ_ENV_PREFIX = "BUZZ_";
export const BUZZ_ENV_EXTRA = ["NOSTR_PRIVATE_KEY"];

export function hookEnv(delivery: Delivery, from: Record<string, string | undefined>, passBuzzEnv: boolean): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(from)) {
    if (v === undefined) continue;
    if (HOOK_ENV_PASSTHROUGH.includes(k) || k.startsWith("LC_")) env[k] = v;
    else if (passBuzzEnv && (k.startsWith(BUZZ_ENV_PREFIX) || BUZZ_ENV_EXTRA.includes(k))) env[k] = v;
  }
  env.RELAY_BACKPORT_EVENT_ID = delivery.event.id;
  env.RELAY_BACKPORT_CHANNEL = delivery.channel;
  env.RELAY_BACKPORT_AUTHOR = delivery.event.pubkey;
  env.RELAY_BACKPORT_KIND = String(delivery.event.kind);
  env.RELAY_BACKPORT_RELAY = delivery.relay;
  env.RELAY_BACKPORT_SESSION_ID = delivery.session.id;
  return env;
}

export class ExecSink implements Sink {
  readonly name = "exec";
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly cfg: ExecConfig,
    private readonly env: Record<string, string | undefined> = process.env,
  ) {}

  deliver(delivery: Delivery): Promise<boolean> {
    const run = this.queue.then(() => this.runOne(delivery)).catch(() => false);
    this.queue = run;
    return run;
  }

  private async runOne(delivery: Delivery): Promise<boolean> {
    const payload = JSON.stringify(buildPayload(delivery, { includeSystemPrompt: this.cfg.includeSystemPrompt }));
    const started = Date.now();
    let proc: Bun.Subprocess<"pipe", "inherit", "inherit">;
    try {
      proc = Bun.spawn(this.cfg.command, {
        stdin: "pipe" as const,
        // "inherit" would be our fd 1, i.e. the ACP stream — route the hook's
        // stdout to our stderr (fd 2) instead.
        stdout: 2 as unknown as "inherit",
        stderr: "inherit" as const,
        env: hookEnv(delivery, this.env, this.cfg.passBuzzEnv),
      });
    } catch (err) {
      log.error("exec spawn failed", { event: delivery.event.id, error: errMessage(err) });
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
      log.warn("exec timed out", { event: delivery.event.id, latency_ms: latency });
      return false;
    }
    if (code !== 0) {
      log.warn("exec exited non-zero", { event: delivery.event.id, code, latency_ms: latency });
      return false;
    }
    log.info("exec delivered", { event: delivery.event.id, latency_ms: latency });
    return true;
  }
}
