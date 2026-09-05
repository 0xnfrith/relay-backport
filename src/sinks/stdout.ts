// stdout sink: one line per mention, `MENTION|{json}`, plus `EVENT|…` lines
// for socket lifecycle. This is the exact contract an interactive Claude Code
// session consumes through its Monitor tool, so the shape must not change:
//   {kind, from (8 hex), h, content (≤400 chars), id, tags, rootId?}
import { formatMentionLine, type MentionRecord } from "../mention";
import type { LifecycleEvent, Sink } from "./index";

export class StdoutSink implements Sink {
  readonly name = "stdout";
  private readonly write: (line: string) => void;

  constructor(writer?: (line: string) => void) {
    this.write = writer ?? ((line) => void process.stdout.write(line + "\n"));
  }

  async deliver(record: MentionRecord): Promise<boolean> {
    try {
      this.write(formatMentionLine(record.event));
      return true;
    } catch {
      return false;
    }
  }

  lifecycle(event: LifecycleEvent): void {
    try {
      switch (event.type) {
        case "closed":
          this.write(`EVENT|closed|${event.code}`);
          break;
        case "error":
          this.write(`EVENT|error|${event.message}`);
          break;
        case "auth-failed":
          this.write(`EVENT|auth-failed|${event.message}`);
          break;
        case "connected":
          this.write(`EVENT|connected|${event.authed ? "authed" : "open"}`);
          break;
      }
    } catch {
      // stdout gone; nothing to do
    }
  }
}
