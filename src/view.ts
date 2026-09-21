// Named views: a per-reader projection of one stored `MENTION|` record.
//
// The file sink writes one record per delivery. A view never rewrites that
// file; `tail --view NAME` prints a shape one kind of consumer can read.
// `claude-code` is the first: two lines in one write, each capped, for a
// Monitor that cuts per line and batches lines printed together.
import { channelOf, threadRoot, type MentionLine } from "./delivery";
import { MENTION_PREFIX } from "./tail";
import type { ThreadContextEntry } from "./thread-context";

export const VIEW_NAMES = ["raw", "claude-code"] as const;
export type ViewName = (typeof VIEW_NAMES)[number];

/** Per-line visible budget for `claude-code`. The writer enforces it. Counted in characters. */
export const DEFAULT_VISIBLE_CHARS = 500;

/** `TEXT | <12 hex> | ` — the longest TEXT prefix (12-hex id). */
export const TEXT_PREFIX_MAX = "TEXT | ".length + 12 + " | ".length;

/** Floor: TEXT prefix plus some body. Smaller values cannot hold a TEXT line. */
export const MIN_VISIBLE_CHARS = TEXT_PREFIX_MAX + 10;

/** ASCII stand-in for a newline inside TEXT, so the byte length matches the character budget. */
export const NEWLINE_MARK = " \\n ";

const NAME_MAX = 32;
const TITLE_MAX = 40;
const PURPOSE_MAX = 40;
const LABEL_MAX = 40;

export type ClaudeCodeViewOptions = {
  visibleChars?: number;
  /** Pubkey prefixes whose catch-up entries are omitted from `thread +N`. */
  hide?: string[];
  /** Channel uuid → purpose. Wins over the stored description. */
  channels?: Record<string, string>;
  /** Pubkey → display label. Wins over the stored sender name. */
  identities?: Record<string, string>;
  /** Configured owner pubkey. Owner status comes only from here, never from text. */
  owner?: string;
};

export function clip(s: string, max: number): string {
  if (max <= 0 || s.length <= max) return max <= 0 ? "" : s;
  return s.slice(0, max);
}

/**
 * Header fields cannot contain newlines, `|`, or brackets. Newlines/`|`
 * would wrap or shift fields; `[` `]` would let a display name or
 * description imitate the `[human, owner]` status block.
 */
export function oneLine(s: string): string {
  return s.replace(/[\n\r|[\]|]+/g, " ").replace(/ +/g, " ").trim();
}

function lookup(map: Record<string, string> | undefined, key: string | undefined): string | undefined {
  if (!map || !key) return undefined;
  const needle = key.toLowerCase();
  const direct = map[needle] ?? map[key];
  if (direct) return direct;
  for (const [k, v] of Object.entries(map)) {
    const kk = k.toLowerCase();
    if (needle.startsWith(kk) || kk.startsWith(needle)) return v;
  }
  return undefined;
}

function matchesPrefix(pubkey: string | undefined, prefixes: string[]): boolean {
  if (!pubkey) return false;
  const p = pubkey.toLowerCase();
  return prefixes.some((h) => h !== "" && (p.startsWith(h.toLowerCase()) || h.toLowerCase().startsWith(p)));
}

function isOwnerKey(pubkey: string | undefined, owner: string | undefined): boolean {
  if (!pubkey || !owner) return false;
  const a = pubkey.toLowerCase();
  const b = owner.toLowerCase();
  return a === b || a.startsWith(b) || b.startsWith(a);
}

function authOwner(tags: unknown): string | undefined {
  if (!Array.isArray(tags)) return undefined;
  for (const t of tags) {
    if (Array.isArray(t) && t[0] === "auth" && typeof t[1] === "string" && t[1]) return t[1].toLowerCase();
  }
  return undefined;
}

export type SenderClass = "human" | "agent" | "unknown";

export type SenderClassInfo = {
  kind: SenderClass;
  /** Configured owner sending as themselves → `[human, owner]` (no name). */
  ownerSelf?: true;
  /** Agent whose auth owner is the configured owner → `[agent, owner <name>]`. */
  ownerLabel?: string;
};

/**
 * `auth` tag → agent (tag[1] is the owner's key). No tag: `human` only if the
 * key is the configured owner or is labelled in `identities`; otherwise
 * `unknown`. Owner status is config-only.
 */
export function classifySender(
  pubkey: string,
  tags: unknown,
  opts: Pick<ClaudeCodeViewOptions, "identities" | "owner">,
): SenderClassInfo {
  const ownerTag = authOwner(tags);
  const labelled = Boolean(lookup(opts.identities, pubkey));
  let kind: SenderClass;
  if (ownerTag) kind = "agent";
  else if (isOwnerKey(pubkey, opts.owner) || labelled) kind = "human";
  else kind = "unknown";

  if (kind === "human" && isOwnerKey(pubkey, opts.owner)) return { kind, ownerSelf: true };
  if (kind === "agent" && ownerTag && isOwnerKey(ownerTag, opts.owner)) {
    return { kind, ownerLabel: clip(oneLine(lookup(opts.identities, opts.owner) ?? "?"), LABEL_MAX) };
  }
  return { kind };
}

function classBracket(cls: SenderClassInfo): string {
  if (cls.kind === "human" && cls.ownerSelf) return "[human, owner]";
  if (cls.kind === "agent" && cls.ownerLabel) return `[agent, owner ${cls.ownerLabel}]`;
  return `[${cls.kind}]`;
}

/** Absent `scope` falls back to tags: a root (or reply) `e` tag means thread. */
export function scopeOf(obj: Pick<MentionLine, "scope" | "tags">): "dm" | "thread" | "channel" {
  if (obj.scope === "dm" || obj.scope === "thread" || obj.scope === "channel") return obj.scope;
  if (Array.isArray(obj.tags)) {
    for (const t of obj.tags) {
      if (Array.isArray(t) && t[0] === "e" && (t[3] === "root" || t[3] === "reply")) return "thread";
    }
  }
  return "channel";
}

const ENTRY_HEAD = /^\[(\d+)\] (.+?) \(([0-9a-fA-F]{8,64})\) \(([^)]+)\): /gm;

/**
 * Split a harness catch-up block of the form `[n] name (pubkey) (time): body`.
 *
 * If that prose changes, this returns the whole block as one unparsed entry
 * (empty pubkey) so a caller prints everything rather than crashing or
 * dropping the catch-up.
 */
export function splitBlockEntries(text: string): { pubkey: string; name: string; text: string }[] {
  const matches = [...text.matchAll(new RegExp(ENTRY_HEAD.source, "gm"))];
  if (matches.length === 0) return [{ pubkey: "", name: "", text }];
  return matches.map((m, i) => {
    const start = m.index ?? 0;
    const end = i + 1 < matches.length ? (matches[i + 1]!.index ?? text.length) : text.length;
    return { pubkey: m[3] ?? "", name: m[2] ?? "", text: text.slice(start, end).replace(/\n$/, "") };
  });
}

function eventAuthor(text: string): string {
  return text.match(/\bfrom ([0-9a-fA-F]{8,64})\b/)?.[1] ?? "";
}

export type SpeakerCount = { name: string; n: number };

/** Catch-up entries not written by a hidden key, grouped by speaker in first-seen order. */
export function catchUpSpeakers(
  threadContext: unknown,
  hide: string[],
  identities: Record<string, string> = {},
): { total: number; groups: SpeakerCount[] } {
  const groups: SpeakerCount[] = [];
  const index = new Map<string, number>();
  const add = (name: string) => {
    const key = name || "?";
    const at = index.get(key);
    if (at === undefined) {
      index.set(key, groups.length);
      groups.push({ name: key, n: 1 });
    } else {
      groups[at]!.n++;
    }
  };
  if (!Array.isArray(threadContext)) return { total: 0, groups };
  for (const item of threadContext) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as ThreadContextEntry;
    const text = typeof rec.text === "string" ? rec.text : "";
    if (!text) continue;
    if (rec.kind === "block") {
      for (const e of splitBlockEntries(text)) {
        if (matchesPrefix(e.pubkey, hide)) continue;
        add(clip(oneLine(lookup(identities, e.pubkey) || e.name || e.pubkey.slice(0, 8) || "?"), LABEL_MAX));
      }
      continue;
    }
    const author = eventAuthor(text);
    if (matchesPrefix(author, hide)) continue;
    add(clip(oneLine(lookup(identities, author) || author.slice(0, 8) || "?"), LABEL_MAX));
  }
  const total = groups.reduce((n, g) => n + g.n, 0);
  return { total, groups };
}

function hhmmz(createdAt: unknown): string {
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt) || createdAt <= 0) return "??:??Z";
  const d = new Date(createdAt * 1000);
  if (Number.isNaN(d.getTime())) return "??:??Z";
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}Z`;
}

function replyOf(obj: MentionLine): string {
  const fromTags = threadRoot({ id: typeof obj.id === "string" ? obj.id : "", tags: Array.isArray(obj.tags) ? obj.tags : [] }).toLowerCase();
  const fromField = typeof obj.reply_to === "string" && /^[0-9a-f]{64}$/i.test(obj.reply_to) ? obj.reply_to.toLowerCase() : undefined;
  if (fromField && fromField !== fromTags) return fromTags;
  return fromField ?? fromTags ?? "?";
}

function threadTitle(threadContext: unknown): string | undefined {
  if (!Array.isArray(threadContext) || threadContext.length === 0) return undefined;
  for (const item of threadContext) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as ThreadContextEntry;
    if (rec.kind !== "block" || typeof rec.text !== "string") continue;
    const entries = splitBlockEntries(rec.text);
    const first = entries[0];
    if (!first) continue;
    const body = first.pubkey
      ? first.text.replace(/^\[\d+\] .+? \([0-9a-fA-F]{8,64}\) \([^)]+\): /, "")
      : first.text;
    const title = clip(oneLine(body), TITLE_MAX);
    if (title) return title;
  }
  return undefined;
}

function whoClause(display: string, cls: SenderClassInfo): string {
  return `from ${display} ${classBracket(cls)}`;
}

/**
 * Project one file-sink line for a `claude-code` reader. `EVENT|` lines and
 * unparseable `MENTION|` lines pass through unchanged. A MENTION record
 * becomes two lines (WAKE, then TEXT) joined by a single newline, so the
 * caller can write them in one syscall.
 */
export function projectClaudeCode(line: string, opts: ClaudeCodeViewOptions = {}): string {
  if (!line.startsWith(MENTION_PREFIX)) return line;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.slice(MENTION_PREFIX.length));
  } catch {
    return line;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return line;
  const obj = parsed as MentionLine;
  const budget = opts.visibleChars ?? DEFAULT_VISIBLE_CHARS;
  const hide = opts.hide ?? [];
  const identities = opts.identities ?? {};
  const channels = opts.channels ?? {};

  const content = typeof obj.content === "string" ? obj.content : "";
  const id = typeof obj.id === "string" ? obj.id.toLowerCase() : "";
  const id12 = id.slice(0, 12) || "?";
  const ch = (typeof obj.h === "string" && obj.h ? obj.h : channelOf({ tags: obj.tags ?? [] })) || "?";
  const pubkey = typeof obj.from === "string" && obj.from !== "unknown" ? obj.from : "";
  const tags = obj.tags;
  const scope = scopeOf(obj);
  const type = scope === "dm" ? "dm" : "mention";

  const display = clip(
    oneLine(lookup(identities, pubkey) || (typeof obj.sender_name === "string" && obj.sender_name) || pubkey || "?"),
    LABEL_MAX,
  );
  const cls = classifySender(pubkey, tags, { identities, owner: opts.owner });
  const who = whoClause(display, cls);

  const purposeRaw = lookup(channels, ch) || (typeof obj.channel_description === "string" ? obj.channel_description : "") || "?";
  const nameRaw = (typeof obj.channel_name === "string" && obj.channel_name) || "?";
  const titleRaw = scope === "thread" ? threadTitle(obj.thread_context) : undefined;
  const speakers = catchUpSpeakers(obj.thread_context, hide, identities);
  const reply = replyOf(obj);
  const at = hhmmz(obj.created_at);
  const len = `${content.length}ch`;

  const assemble = (nameMax: number, titleMax: number, purposeMax: number, speakersMax: number) => {
    const name = clip(oneLine(nameRaw), nameMax) || "?";
    const purpose = clip(oneLine(purposeRaw), purposeMax) || "?";
    const title = titleRaw ? clip(oneLine(titleRaw).replace(/"/g, "'"), titleMax) : undefined;
    const scopeBit = title && titleMax > 0 ? `${scope} "${title}"` : scope;
    let thread = `thread +${speakers.total}`;
    if (speakers.total > 0 && speakersMax > 0) {
      const inner = speakers.groups.map((g) => `${g.name} ${g.n}`).join(", ");
      thread += ` (${clip(inner, speakersMax)})`;
    }
    if (type === "dm") {
      return `WAKE dm | DM with ${display} ${classBracket(cls)} | reply ${reply} | ch ${ch} | id ${id12} | ${at} | ${thread} | ${len}`;
    }
    return `WAKE ${type} | #${name} (${scopeBit}) - ${purpose} | ${who} | reply ${reply} | ch ${ch} | id ${id12} | ${at} | ${thread} | ${len}`;
  };

  let nameMax = NAME_MAX;
  let titleMax = TITLE_MAX;
  let purposeMax = PURPOSE_MAX;
  let speakersMax = 80;
  let header = assemble(nameMax, titleMax, purposeMax, speakersMax);
  const shrink = (need: number, current: number) => Math.max(0, current - need);
  if (header.length > budget) {
    purposeMax = shrink(header.length - budget, purposeMax);
    header = assemble(nameMax, titleMax, purposeMax, speakersMax);
  }
  if (header.length > budget) {
    titleMax = shrink(header.length - budget, titleMax);
    header = assemble(nameMax, titleMax, purposeMax, speakersMax);
  }
  if (header.length > budget) {
    nameMax = shrink(header.length - budget, nameMax);
    header = assemble(nameMax, titleMax, purposeMax, speakersMax);
  }
  if (header.length > budget) {
    speakersMax = shrink(header.length - budget, speakersMax);
    header = assemble(nameMax, titleMax, purposeMax, speakersMax);
  }
  if (header.length > budget) header = header.slice(0, budget);

  const marked = content.replace(/\r\n|\n|\r/g, NEWLINE_MARK);
  const textPrefix = `TEXT | ${id12} | `;
  const room = Math.max(0, budget - textPrefix.length);
  const textBody = clip(marked, room);
  let textLine = `${textPrefix}${textBody}`;
  if (textLine.length > budget) textLine = textLine.slice(0, budget);
  return `${header}\n${textLine}`;
}
