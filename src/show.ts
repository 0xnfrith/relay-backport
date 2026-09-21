// `relay-backport show` — read one `MENTION|` record from the local
// deliveries file (the tail of the file; a partial last line is ignored)
// and print the header, the full message, and the thread catch-up with
// hidden authors removed. Offline: it never talks to the relay.
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { MENTION_PREFIX } from "./tail";
import { splitBlockEntries } from "./view";

export const SHOW_TAIL_BYTES = 2 * 1024 * 1024;

export class ShowError extends Error {
  readonly exitCode = 1;
}

function readRangeBuf(path: string, start: number, end: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(Math.max(0, end - start));
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, start + got);
      if (n === 0) break;
      got += n;
    }
    return buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

/**
 * Complete lines from the tail of `path`. A partial first line (when the
 * window does not start at byte 0) and a partial last line (no trailing
 * newline) are dropped, never parsed.
 */
export function readCompleteTailLines(path: string, maxBytes = SHOW_TAIL_BYTES): string[] {
  let size: number;
  try {
    size = statSync(path).size;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new ShowError(`show: deliveries file not found: ${path}`);
    throw new ShowError(`show: cannot read deliveries file: ${path}`);
  }
  const start = Math.max(0, size - maxBytes);
  let text = readRangeBuf(path, start, size).toString("utf8");
  if (start > 0) {
    const nl = text.indexOf("\n");
    if (nl < 0) return [];
    text = text.slice(nl + 1);
  }
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  else lines.pop(); // incomplete last line
  return lines;
}

function parseMention(line: string): { line: string; obj: Record<string, unknown>; id: string } | undefined {
  if (!line.startsWith(MENTION_PREFIX)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.slice(MENTION_PREFIX.length));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const obj = parsed as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id.toLowerCase() : "";
  return { line, obj, id };
}

export type MentionHit = { line: string; obj: Record<string, unknown>; id: string };

/** Every parseable MENTION in `lines`, in file order. */
export function mentionHits(lines: string[]): MentionHit[] {
  const out: MentionHit[] = [];
  for (const line of lines) {
    const hit = parseMention(line);
    if (hit) out.push(hit);
  }
  return out;
}

/**
 * Resolve `--last` / `--id PREFIX` against the file tail. Distinct event ids
 * that share a prefix are an error; a redelivered same id is not.
 */
export function resolveMention(hits: MentionHit[], idPrefix?: string): MentionHit {
  if (hits.length === 0) throw new ShowError("show: no matching MENTION line");
  if (!idPrefix) return hits[hits.length - 1]!;
  const needle = idPrefix.toLowerCase();
  const matched = hits.filter((h) => h.id.startsWith(needle));
  const unique = new Set(matched.map((h) => h.id));
  if (unique.size === 0) throw new ShowError(`show: no matching MENTION line`);
  if (unique.size > 1) throw new ShowError(`show: id prefix "${idPrefix}" matches ${unique.size} records`);
  return matched[matched.length - 1]!;
}

function tagValues(tags: unknown, name: string): string[] {
  if (!Array.isArray(tags)) return [];
  const out: string[] = [];
  for (const t of tags) {
    if (Array.isArray(t) && t[0] === name && typeof t[1] === "string") out.push(t[1]);
  }
  return out;
}

function eTagged(tags: unknown, marker: string): string[] {
  if (!Array.isArray(tags)) return [];
  const out: string[] = [];
  for (const t of tags) {
    if (Array.isArray(t) && t[0] === "e" && typeof t[1] === "string") {
      const m = typeof t[3] === "string" ? t[3] : "";
      if (m === marker) out.push(t[1]);
    }
  }
  return out;
}

function eventAuthor(text: string): string {
  return text.match(/\bfrom ([0-9a-fA-F]{8,64})\b/)?.[1] ?? "";
}

function isHidden(pubkey: string, hide: string[]): boolean {
  if (!pubkey || hide.length === 0) return false;
  const p = pubkey.toLowerCase();
  return hide.some((h) => h !== "" && (p.startsWith(h.toLowerCase()) || h.toLowerCase().startsWith(p)));
}

/**
 * Filter `thread_context` down to entries not authored by a hidden key.
 *
 * Block prose is `[n] name (pubkey) (time): body` — see `splitBlockEntries`.
 * A format change degrades to "print everything" (the unparsed block is
 * kept), never to a crash.
 */
export function filterCatchUp(threadContext: unknown, hide: string[]): { kept: string[]; hidden: number } {
  const kept: string[] = [];
  let hidden = 0;
  if (!Array.isArray(threadContext)) return { kept, hidden };
  for (const item of threadContext) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as { kind?: unknown; text?: unknown };
    const text = typeof rec.text === "string" ? rec.text : "";
    if (!text) continue;
    if (rec.kind === "block") {
      const remaining: string[] = [];
      for (const e of splitBlockEntries(text)) {
        if (e.pubkey && isHidden(e.pubkey, hide)) hidden++;
        else remaining.push(e.text);
      }
      if (remaining.length) kept.push(remaining.join("\n"));
      continue;
    }
    const author = eventAuthor(text);
    if (author && isHidden(author, hide)) {
      hidden++;
      continue;
    }
    kept.push(text);
  }
  return { kept, hidden };
}

export function formatShowHeader(obj: Record<string, unknown>): string {
  const id = typeof obj.id === "string" ? obj.id : "-";
  const from = typeof obj.from === "string" ? obj.from : "-";
  const h = typeof obj.h === "string" ? obj.h : "-";
  const tags = obj.tags;
  const roots = eTagged(tags, "root");
  const replies = eTagged(tags, "reply");
  const replyTo = typeof obj.reply_to === "string" ? obj.reply_to : replies.join(",") || "-";
  const root = roots.join(",") || "-";
  const ps = tagValues(tags, "p").join(",") || "-";
  return `${id} from=${from} h=${h} root=${root} reply=${replyTo} p=${ps}`;
}

export function formatShow(obj: Record<string, unknown>, hide: string[]): string {
  const content = typeof obj.content === "string" ? obj.content : "";
  const { kept, hidden } = filterCatchUp(obj.thread_context, hide);
  const noun = hidden === 1 ? "message" : "messages";
  const parts = [formatShowHeader(obj), content, ...kept, `${hidden} ${noun} hidden`];
  return parts.join("\n");
}

export type ShowOptions = {
  path: string;
  /** Event-id prefix. Omit / empty means the last MENTION. */
  id?: string;
  hide?: string[];
  raw?: boolean;
};

export function showDeliveries(opts: ShowOptions): string {
  const lines = readCompleteTailLines(opts.path);
  const hits = mentionHits(lines);
  const hit = resolveMention(hits, opts.id);
  if (opts.raw) return hit.line;
  return formatShow(hit.obj, opts.hide ?? []);
}
