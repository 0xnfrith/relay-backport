// Cumulative thread context, for a receiver that keeps no state.
//
// `buzz-acp` builds each prompt's thread context ONCE per session: turn 1 of a
// thread carries the history in a `<thread-context>` block, and every later
// turn in the same session is told, in prose, that "Earlier thread context was
// already delivered in this session". That is the right thing to send a
// long-lived agent process holding a conversation — and exactly the wrong
// thing to POST at a stateless webhook, which gets the history on the first
// request and nothing but a bare delta on every one after it.
//
// So relay-backport can keep the ledger the receiver cannot: per ACP session,
// the thread-context blocks it has seen, in order, replayed on every POST as
// `thread_context_cumulative`. The per-turn `prompt` is untouched — it is what
// the observe page renders verbatim and counts tokens from — and the extra
// field is simply absent in the default `delta` mode.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { outerBlock } from "./prompt";

export type ThreadContextMode = "delta" | "cumulative";
export const THREAD_CONTEXT_MODES: ThreadContextMode[] = ["delta", "cumulative"];
export const DEFAULT_CUMULATIVE_MAX_CHARS = 32_000;

/**
 * The tags `buzz-acp` wraps history in, in the order they are tried. A prompt
 * carries at most one; `thread-context` is a reply chain, `conversation-context`
 * is recent channel traffic.
 */
export const CONTEXT_TAGS = ["thread-context", "conversation-context"] as const;

export type LedgerEntry = {
  /** The event whose prompt carried this block — the dedup key across retries. */
  event_id: string;
  at: number;
  text: string;
};

/**
 * The context block a prompt carries, or undefined. Parsed with the same
 * outermost-span rule the event parser uses, so a forged `</thread-context>`
 * inside a message body stays inside the real block instead of truncating it.
 */
export function extractThreadContext(prompt: string): string | undefined {
  for (const tag of CONTEXT_TAGS) {
    const block = outerBlock(prompt, tag);
    if (block && block.body.trim() !== "") return block.body;
  }
  return undefined;
}

export type Accumulated = { text: string; truncated: boolean; entries: number };

/**
 * Join the ledger oldest-first, dropping whole entries from the FRONT until it
 * fits. Oldest first because the newest context is the one the receiver most
 * needs; a partial block would be worse than a missing one, so entries are
 * dropped whole. A single entry over the bound is kept and cut at the end.
 */
export function accumulate(entries: LedgerEntry[], maxChars: number): Accumulated {
  const kept: LedgerEntry[] = [];
  let total = 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i]!;
    const cost = e.text.length + (kept.length > 0 ? 2 : 0);
    if (total + cost > maxChars && kept.length > 0) break;
    kept.unshift(e);
    total += cost;
  }
  let text = kept.map((e) => e.text).join("\n\n");
  let truncated = kept.length < entries.length;
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    truncated = true;
  }
  return { text, truncated, entries: kept.length };
}

export function ledgerPath(stateDir: string, sessionId: string): string {
  return join(stateDir, "sessions", `${sessionId}.context.jsonl`);
}

/**
 * The per-session ledger: in memory, and appended to
 * `<state_dir>/sessions/<session id>.context.jsonl` so a relay-backport
 * restart inside a live session keeps what it already forwarded. One JSON
 * object per line; an unparsable line is skipped rather than fatal.
 */
export class ThreadContextLedger {
  private readonly sessions = new Map<string, LedgerEntry[]>();

  constructor(
    private readonly stateDir: string,
    private readonly maxChars: number = DEFAULT_CUMULATIVE_MAX_CHARS,
    private readonly io: {
      read?: (p: string) => string;
      append?: (p: string, line: string) => void;
    } = {},
  ) {}

  /** The entries for a session, read from disk the first time it is asked for. */
  entries(sessionId: string): LedgerEntry[] {
    const cached = this.sessions.get(sessionId);
    if (cached) return cached;
    const loaded: LedgerEntry[] = [];
    try {
      const read = this.io.read ?? ((p: string) => readFileSync(p, "utf8"));
      for (const line of read(ledgerPath(this.stateDir, sessionId)).split("\n")) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as LedgerEntry;
          if (typeof e?.text === "string" && typeof e?.event_id === "string") loaded.push(e);
        } catch {
          // a torn or hand-edited line is skipped, not fatal
        }
      }
    } catch {
      // no ledger on disk yet
    }
    this.sessions.set(sessionId, loaded);
    return loaded;
  }

  /** Record a block once per event. Returns false when it was already there. */
  append(sessionId: string, entry: LedgerEntry): boolean {
    const entries = this.entries(sessionId);
    if (entries.some((e) => e.event_id === entry.event_id)) return false;
    entries.push(entry);
    const write =
      this.io.append ??
      ((p: string, line: string) => {
        mkdirSync(join(this.stateDir, "sessions"), { recursive: true, mode: 0o700 });
        appendFileSync(p, line + "\n", { mode: 0o600 });
      });
    try {
      write(ledgerPath(this.stateDir, sessionId), JSON.stringify(entry));
    } catch {
      // The ledger is a durability nicety: losing the file costs a restart's
      // worth of history, not a delivery. Never fail a delivery over it.
    }
    return true;
  }

  /** Everything recorded for a session, bounded. */
  accumulated(sessionId: string): Accumulated {
    return accumulate(this.entries(sessionId), this.maxChars);
  }
}
