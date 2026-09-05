// From an ACP `session/prompt` to the Buzz event behind it.
//
// Precedence:
//   1. `_meta.buzz.events[]` — the structured shape the client may attach
//      (in flight upstream); the last event routes, as in the harness.
//   2. Buzz's prompt text framing — a `<context>` block plus one
//      `<buzz-event>` (or several inside `<buzz-events>`), each a run of
//      `Event ID:` / `Channel:` / `Kind:` / `From:` / `Time:` / `Content:` /
//      `Tags:` / `Parsed:` lines. Only `Content:` may span lines.
//   3. A synthetic event: a stable sha256 id, sender unknown, the raw prompt
//      as content — so a prompt from any ACP client still reaches the sinks.
import { createHash } from "node:crypto";
import type { EventLike, EventSource } from "./delivery";
import { channelOf } from "./delivery";

const HEX64 = /^[0-9a-f]{64}$/i;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export type ResolvedEvent = {
  event: EventLike;
  channel: string;
  source: EventSource;
  events?: unknown[];
};

/** The text of every `text` content block, joined with newlines. */
export function promptText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  const texts: string[] = [];
  for (const b of blocks) {
    if (b && typeof b === "object" && (b as { type?: unknown }).type === "text") {
      const t = (b as { text?: unknown }).text;
      if (typeof t === "string") texts.push(t);
    }
  }
  return texts.join("\n");
}

export function syntheticId(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function asEvent(raw: unknown): EventLike | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !HEX64.test(r.id)) return undefined;
  const tags = Array.isArray(r.tags)
    ? r.tags.filter((t): t is string[] => Array.isArray(t) && t.every((x) => typeof x === "string"))
    : [];
  return {
    id: r.id.toLowerCase(),
    kind: typeof r.kind === "number" ? r.kind : 9,
    pubkey: typeof r.pubkey === "string" && HEX64.test(r.pubkey) ? r.pubkey.toLowerCase() : "",
    content: typeof r.content === "string" ? r.content : "",
    tags,
    created_at: typeof r.created_at === "number" ? r.created_at : Math.floor(Date.now() / 1000),
  };
}

/**
 * The body between the FIRST opening `<tag …>` and the LAST `</tag>` of a
 * prompt, plus the opening tag's attributes. The harness emits at most one
 * such block per prompt and does not escape the block body, so message text
 * may contain a forged `</tag>\n<tag>\nEvent ID: …` sequence; taking the
 * outermost span keeps that forgery inside the real block's `Content:`.
 */
function outerBlock(text: string, tag: string): { body: string; attrs: string } | undefined {
  const open = text.match(new RegExp(`<${tag}((?:\\s[^>]*)?)>\\n?`));
  if (!open || open.index === undefined) return undefined;
  const start = open.index + open[0].length;
  const end = text.lastIndexOf(`</${tag}>`);
  if (end < start) return undefined;
  return { body: text.slice(start, end).replace(/\n$/, ""), attrs: open[1] ?? "" };
}

const SEPARATOR = /^--- Event (\d+) [^\n]*---\n/m;

/**
 * The event that routes a `<buzz-events>` batch. The harness separates events
 * with `--- Event N (…) ---` lines, numbered 1..count, and the last one
 * routes. Only the FIRST event's header is beyond an attacker's reach (every
 * later byte follows some message body), so the separators are verified
 * against the `count` attribute: exactly `count` of them, labelled 1..count in
 * order. Any forged separator breaks that sequence, and the batch then routes
 * on the first event instead — never on a forged one.
 */
function routingSegment(batch: { body: string; attrs: string } | undefined): string | undefined {
  if (!batch) return undefined;
  const count = Number.parseInt(batch.attrs.match(/count="(\d+)"/)?.[1] ?? "", 10);
  const labels: number[] = [];
  const parts = batch.body.split(new RegExp(SEPARATOR.source, "gm"));
  // split() with a capture group interleaves [pre, label, segment, label, segment, …]
  const segments: string[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    labels.push(Number.parseInt(parts[i] ?? "", 10));
    segments.push(parts[i + 1] ?? "");
  }
  if (segments.length === 0) return batch.body.includes("Event ID:") ? batch.body : undefined;
  const wellFormed = Number.isFinite(count) && labels.length === count && labels.every((n, i) => n === i + 1);
  return wellFormed ? segments[segments.length - 1] : segments[0];
}

/** First-match field, restricted to the header — the lines before `Content:`, which no message body precedes. */
function headerField(segment: string, name: string): string | undefined {
  const contentAt = segment.search(/(?:^|\n)Content: /);
  const header = contentAt >= 0 ? segment.slice(0, contentAt) : segment;
  return header.match(new RegExp(`^${name}: (.*)$`, "m"))?.[1]?.trim();
}

function field(block: string, name: string): string | undefined {
  return block.match(new RegExp(`^${name}: (.*)$`, "m"))?.[1]?.trim();
}

/** The `Tags:` line the harness writes AFTER the content — the last one in the segment. */
function lastTagsLine(segment: string): { at: number; value: string } | undefined {
  let last: { at: number; value: string } | undefined;
  for (const m of segment.matchAll(/^Tags: (.*)$/gm)) if (m.index !== undefined) last = { at: m.index, value: m[1] ?? "" };
  return last;
}

/**
 * Parse the harness's text framing. Undefined when the prompt carries no
 * `<buzz-event>` / `<buzz-events>` block. Field order in a block is fixed
 * (`Event ID`, `Channel`, `Kind`, `From`, `Time`, `Content`, `Tags`, `Parsed`)
 * and only `Content:` is message text, so header fields are read from before
 * the content and `Tags:` from after it — a forgery inside the content can
 * neither replace a header field nor the real tags.
 */
export function parseBuzzPrompt(text: string): { event: EventLike; channel: string } | undefined {
  const block = outerBlock(text, "buzz-event")?.body ?? routingSegment(outerBlock(text, "buzz-events"));
  if (!block) return undefined;

  const idRaw = headerField(block, "Event ID");
  const id = idRaw && HEX64.test(idRaw) ? idRaw.toLowerCase() : syntheticId(text);
  const channelLine = headerField(block, "Channel") ?? field(outerBlock(text, "context")?.body ?? "", "Channel") ?? "";
  const channel = channelLine.match(/#(?<id>[0-9a-f-]{36})/i)?.groups?.id?.toLowerCase() ?? channelLine.match(UUID)?.[0]?.toLowerCase() ?? "";
  const kindRaw = Number.parseInt(headerField(block, "Kind") ?? "", 10);
  const kind = Number.isFinite(kindRaw) ? kindRaw : 9;
  const fromLine = headerField(block, "From") ?? "";
  const pubkey = (fromLine.match(/hex: (?<hex>[0-9a-f]{64})/i)?.groups?.hex ?? fromLine.match(/[0-9a-f]{64}/i)?.[0] ?? "").toLowerCase();
  const timeRaw = headerField(block, "Time");
  const parsedTime = timeRaw ? Date.parse(timeRaw) : Number.NaN;
  const created_at = Number.isFinite(parsedTime) ? Math.floor(parsedTime / 1000) : Number.parseInt(timeRaw ?? "", 10) || Math.floor(Date.now() / 1000);

  const contentMatch = block.match(/(?:^|\n)Content: /);
  const contentStart = contentMatch?.index !== undefined ? contentMatch.index + contentMatch[0].length : -1;
  const tagsLine = lastTagsLine(block);
  let content = "";
  if (contentStart >= 0) {
    let contentEnd = block.length;
    if (tagsLine && tagsLine.at > contentStart) contentEnd = tagsLine.at;
    else {
      const parsedAt = block.lastIndexOf("\nParsed: ");
      if (parsedAt > contentStart) contentEnd = parsedAt + 1;
    }
    content = block.slice(contentStart, contentEnd).replace(/\n$/, "");
  }
  let tags: string[][] = [];
  if (tagsLine && (contentStart < 0 || tagsLine.at > contentStart)) {
    try {
      const parsed = JSON.parse(tagsLine.value) as unknown;
      if (Array.isArray(parsed)) tags = parsed.filter((t): t is string[] => Array.isArray(t) && t.every((x) => typeof x === "string"));
    } catch {
      // keep going without tags
    }
  }
  if (channel && !tags.some((t) => t[0] === "h")) tags = [["h", channel], ...tags];
  return { event: { id, kind, pubkey, content, tags, created_at }, channel };
}

/** Resolve the event a prompt is about (see the precedence at the top of the file). */
export function resolveEvent(text: string, meta: unknown): ResolvedEvent {
  const buzz = meta && typeof meta === "object" ? (meta as { buzz?: unknown }).buzz : undefined;
  const events = buzz && typeof buzz === "object" ? (buzz as { events?: unknown }).events : undefined;
  if (Array.isArray(events) && events.length > 0) {
    const event = asEvent(events[events.length - 1]);
    if (event) return { event, channel: channelOf(event), source: "meta", events };
  }
  const parsed = parseBuzzPrompt(text);
  if (parsed) return { ...parsed, source: "text" };
  return {
    event: { id: syntheticId(text), kind: 9, pubkey: "", content: text, tags: [], created_at: Math.floor(Date.now() / 1000) },
    channel: "",
    source: "synthetic",
  };
}
