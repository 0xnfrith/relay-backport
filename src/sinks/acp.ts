// acp sink — SCAFFOLD ONLY.
//
// The idea: the daemon acts as an ACP (Agent Client Protocol) client. It
// spawns the agent process named in `acp.command` (for example a runtime's
// `<cli> acp` / `--experimental-acp` mode, or a wrapper adapter), speaks
// JSON-RPC over the child's stdio, and forwards each mention as a prompt:
//
//   initialize      → negotiate protocol version + capabilities
//   session/new     → one session per channel (or per thread root)
//   session/prompt  → the mention text, with channel/thread ids as context
//
// The agent's reply would go back to the relay through the agent's own Buzz
// tooling, not through this daemon — this daemon never publishes on behalf
// of a sink.
//
// Status: interface in place, transport not implemented, nothing verified
// against a real ACP agent. The README support table lists it as
// "possible, untested". Selecting it logs a warning and rejects every
// delivery, so a mention routed only to this sink is NOT marked delivered
// (it will be replayed on the next restart within the replay window).
import type { AcpConfig } from "../config";
import { log } from "../log";
import type { MentionRecord } from "../mention";
import type { Sink } from "./index";

/** What a full implementation would need to expose. */
export interface AcpClient {
  start(): Promise<void>;
  initialize(): Promise<{ protocolVersion: number }>;
  newSession(cwd: string): Promise<{ sessionId: string }>;
  prompt(sessionId: string, text: string, context: Record<string, unknown>): Promise<void>;
  stop(): Promise<void>;
}

export class AcpSink implements Sink {
  readonly name = "acp";
  private warned = false;

  constructor(readonly cfg: AcpConfig) {}

  async deliver(record: MentionRecord): Promise<boolean> {
    if (!this.warned) {
      this.warned = true;
      log.warn("acp sink is a scaffold: not implemented; mentions routed here are not delivered", {
        command: this.cfg.command,
      });
    }
    log.debug("acp sink skipped mention", { event: record.event.id });
    return false;
  }
}
