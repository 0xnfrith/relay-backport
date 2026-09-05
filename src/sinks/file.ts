// file sink: one `MENTION|{json}` line per delivery appended to a file, plus
// `EVENT|…` lines for the ACP session lifecycle. This is the v0.1 stdout
// contract moved to a file, because in harness mode stdout belongs to the
// ACP stream: `relay-backport tail` follows the file and prints exactly
// those lines, so a Claude Code Monitor tool consumes them unchanged.
//
//   MENTION|{kind, from (8 hex | "unknown"), h, content (≤400 chars), id, tags, rootId?}
//   EVENT|session|new|<session id>
//   EVENT|session|new|<session id>|<absolute path to the system prompt file>
//   EVENT|session|cancel|<session id>
//   EVENT|acp|closed
//
// Each MENTION|/EVENT| line is a single O_APPEND write to a file opened per
// line, mode 0600, so concurrent writers interleave whole lines and a
// rotated or deleted file is simply recreated.
//
// Two more files this sink can write, both 0600 and atomic (write to a
// sibling temp file, then rename over the target so a reader never sees a
// partial write):
//
//   <state_dir>/sessions/<session id>.system-prompt.md   the session/new
//     system prompt, written once per session (`file.system_prompt`,
//     default true).
//
//   `file.buzz_env_file`, when set (default: unset) — the Buzz-injected
//     BUZZ_RELAY_URL / BUZZ_PRIVATE_KEY / BUZZ_AUTH_TAG, whichever are
//     present, as KEY=value lines, rewritten on every session/new. This is
//     the agent's own private key: it exists so a terminal session sitting
//     next to the delivery file can `source` it and use the `buzz` CLI as
//     the agent. Off by default — turn it on only for a consumer that needs
//     to act as the agent, not just read its mentions.
import { closeSync, mkdirSync, openSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { formatMentionLine, type Delivery } from "../delivery";
import { log, errMessage } from "../log";
import type { LifecycleEvent, Sink } from "./index";

export type FileSinkOptions = {
  /** The `MENTION|`/`EVENT|` delivery file `tail` follows. */
  path: string;
  /** Base directory for `sessions/<id>.system-prompt.md`. Defaults to `dirname(path)`. */
  stateDir?: string;
  /** Write the session/new system prompt to disk. Default true. */
  systemPrompt?: boolean;
  /** When set, (re)write the present `BUZZ_*` vars here on every session/new. */
  buzzEnvFile?: string;
  /** Where the Buzz-injected env comes from. Default `process.env`. */
  env?: Record<string, string | undefined>;
};

/** The Buzz-injected identity variables a terminal session needs to call the `buzz` CLI as the agent. */
export const BUZZ_ENV_VARS = ["BUZZ_RELAY_URL", "BUZZ_PRIVATE_KEY", "BUZZ_AUTH_TAG"];

export function systemPromptPath(stateDir: string, sessionId: string): string {
  return join(stateDir, "sessions", `${sessionId}.system-prompt.md`);
}

/** Write `content` to `path` atomically at mode 0600: temp file + rename. */
export function writeFileAtomic(path: string, content: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, content, { mode });
  renameSync(tmp, path);
}

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
      return event.systemPromptPath ? `EVENT|session|new|${event.sessionId}|${event.systemPromptPath}` : `EVENT|session|new|${event.sessionId}`;
    case "session-cancel":
      return `EVENT|session|cancel|${event.sessionId}`;
    case "closed":
      return "EVENT|acp|closed";
  }
}

export class FileSink implements Sink {
  readonly name = "file";
  private readonly path: string;
  private readonly stateDir: string;
  private readonly systemPromptEnabled: boolean;
  private readonly buzzEnvFile: string | undefined;
  private readonly env: Record<string, string | undefined>;

  constructor(opts: FileSinkOptions) {
    this.path = opts.path;
    this.stateDir = opts.stateDir ?? dirname(opts.path);
    this.systemPromptEnabled = opts.systemPrompt ?? true;
    this.buzzEnvFile = opts.buzzEnvFile;
    this.env = opts.env ?? process.env;
  }

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
    // Each side effect gets its own try/catch: a failed system-prompt or
    // buzz-env write must never suppress the EVENT| lifecycle line the v0.1
    // tail contract depends on — e.g. a writable delivery file but a
    // read-only state_dir for the sessions/ subdirectory.
    let toWrite: LifecycleEvent = event;
    if (event.type === "session-new") {
      if (this.systemPromptEnabled && event.systemPrompt) {
        try {
          const p = systemPromptPath(this.stateDir, event.sessionId);
          writeFileAtomic(p, event.systemPrompt);
          toWrite = { ...event, systemPromptPath: p };
          log.info("wrote system prompt file", { session: event.sessionId, path: p, chars: event.systemPrompt.length });
        } catch (err) {
          log.warn("system prompt write failed", { session: event.sessionId, error: errMessage(err) });
        }
      }
      if (this.buzzEnvFile) {
        try {
          this.writeBuzzEnvFile();
        } catch (err) {
          log.warn("buzz env file write failed", { path: this.buzzEnvFile, error: errMessage(err) });
        }
      }
    }
    try {
      appendLine(this.path, formatLifecycleLine(toWrite));
    } catch (err) {
      log.warn("file lifecycle append failed", { path: this.path, error: errMessage(err) });
    }
  }

  /** Never logs a value — only the path and how many variables were present. */
  private writeBuzzEnvFile(): void {
    const lines: string[] = [];
    for (const key of BUZZ_ENV_VARS) {
      const v = this.env[key];
      if (v !== undefined && v !== "") lines.push(`${key}=${v}`);
    }
    writeFileAtomic(this.buzzEnvFile!, lines.length ? lines.join("\n") + "\n" : "");
    log.info(`wrote buzz env file ${this.buzzEnvFile} (${lines.length} vars)`);
  }
}
