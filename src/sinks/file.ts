// file sink: one `MENTION|{json}` line per delivery appended to a file, plus
// `EVENT|…` lines for the ACP session lifecycle. This is the v0.1 stdout
// contract moved to a file, because in harness mode stdout belongs to the
// ACP stream: `relay-backport tail` follows the file and prints exactly
// those lines, so a Claude Code Monitor tool consumes them unchanged.
//
//   MENTION|{kind, from (8 hex | "unknown"), h, content (≤400 chars), id, tags, rootId?}
//   EVENT|session|new|<session id>
//   EVENT|session|cancel|<session id>
//   EVENT|acp|closed
//
// Each line is a single O_APPEND write to a file opened per line, mode 0600,
// so concurrent writers interleave whole lines and a rotated or deleted file
// is simply recreated.
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { formatMentionLine, type Delivery } from "../delivery";
import { log, errMessage } from "../log";
import type { LifecycleEvent, Sink } from "./index";

export function appendLine(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, "a", 0o600);
  try {
    writeSync(fd, line + "\n");
  } finally {
    closeSync(fd);
  }
}

export function formatLifecycleLine(event: LifecycleEvent): string {
  switch (event.type) {
    case "session-new":
      return `EVENT|session|new|${event.sessionId}`;
    case "session-cancel":
      return `EVENT|session|cancel|${event.sessionId}`;
    case "closed":
      return "EVENT|acp|closed";
  }
}

export class FileSink implements Sink {
  readonly name = "file";

  constructor(readonly path: string) {}

  async deliver(delivery: Delivery): Promise<boolean> {
    try {
      appendLine(this.path, formatMentionLine(delivery.event));
      log.info("file delivered", { event: delivery.event.id, path: this.path });
      return true;
    } catch (err) {
      log.error("file append failed", { path: this.path, error: errMessage(err) });
      return false;
    }
  }

  lifecycle(event: LifecycleEvent): void {
    try {
      appendLine(this.path, formatLifecycleLine(event));
    } catch (err) {
      log.warn("file lifecycle append failed", { path: this.path, error: errMessage(err) });
    }
  }
}
