// A sink receives every delivery. Several can run at once; the turn's
// acknowledgement counts how many accepted it.
import type { Config } from "../config";
import type { Delivery } from "../delivery";
import { ExecSink } from "./exec";
import { FileSink } from "./file";
import { WebhookSink } from "./webhook";

export type LifecycleEvent =
  | { type: "session-new"; sessionId: string }
  | { type: "session-cancel"; sessionId: string }
  | { type: "closed" };

export interface Sink {
  readonly name: string;
  /** Resolve true when the consumer accepted the delivery. Never throw. */
  deliver(delivery: Delivery): Promise<boolean>;
  /** ACP session lifecycle, for consumers that watch the stream. */
  lifecycle?(event: LifecycleEvent): void;
  close?(): Promise<void>;
}

export type SinkFactoryOptions = {
  readFile?: (path: string) => string;
  /** The harness environment the exec sink may pass through (default: process.env). */
  env?: Record<string, string | undefined>;
};

export function buildSinks(cfg: Config, opts: SinkFactoryOptions = {}): Sink[] {
  const sinks: Sink[] = [];
  for (const name of cfg.sinks) {
    switch (name) {
      case "file":
        if (!cfg.file) throw new Error("file sink selected without file config");
        sinks.push(new FileSink(cfg.file.path));
        break;
      case "webhook":
        if (!cfg.webhook) throw new Error("webhook sink selected without webhook config");
        sinks.push(new WebhookSink(cfg.webhook, opts.readFile));
        break;
      case "exec":
        if (!cfg.exec) throw new Error("exec sink selected without exec config");
        sinks.push(new ExecSink(cfg.exec, opts.env));
        break;
    }
  }
  return sinks;
}

export { FileSink, WebhookSink, ExecSink };
