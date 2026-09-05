// A sink receives every mention that passed the allowlist. Several can run at
// once; a mention is "delivered" only when all of them accepted it.
import type { Config } from "../config";
import type { MentionRecord } from "../mention";
import { AcpSink } from "./acp";
import { ExecSink } from "./exec";
import { StdoutSink } from "./stdout";
import { WebhookSink } from "./webhook";

export type LifecycleEvent =
  | { type: "connected"; authed: boolean }
  | { type: "closed"; code: number; reason: string }
  | { type: "error"; message: string }
  | { type: "auth-failed"; message: string };

export interface Sink {
  readonly name: string;
  /** Resolve true when the consumer accepted the mention. Never throw. */
  deliver(record: MentionRecord): Promise<boolean>;
  /** Connection lifecycle, for consumers that supervise the daemon. */
  lifecycle?(event: LifecycleEvent): void;
  close?(): Promise<void>;
}

export type SinkFactoryOptions = {
  /** Test seam for the stdout sink. */
  stdoutWriter?: (line: string) => void;
  readFile?: (path: string) => string;
};

export function buildSinks(cfg: Config, opts: SinkFactoryOptions = {}): Sink[] {
  const sinks: Sink[] = [];
  for (const name of cfg.sinks) {
    switch (name) {
      case "stdout":
        sinks.push(new StdoutSink(opts.stdoutWriter));
        break;
      case "webhook":
        if (!cfg.webhook) throw new Error("webhook sink selected without webhook config");
        sinks.push(new WebhookSink(cfg.webhook, opts.readFile));
        break;
      case "exec":
        if (!cfg.exec) throw new Error("exec sink selected without exec config");
        sinks.push(new ExecSink(cfg.exec));
        break;
      case "acp":
        sinks.push(new AcpSink(cfg.acp ?? { command: [] }));
        break;
    }
  }
  return sinks;
}

export { StdoutSink, WebhookSink, ExecSink, AcpSink };
