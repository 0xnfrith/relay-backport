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

function lastBlock(text: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>\\n?([\\s\\S]*?)\\n?</${tag}>`, "g");
  let last: string | undefined;
  for (const m of text.matchAll(re)) last = m[1];
  return last;
}

/** Inside a `<buzz-events>` batch the events are separated by `--- Event N (…) ---` lines; take the last. */
function lastEventSegment(batch: string | undefined): string | undefined {
  if (!batch) return undefined;
  const parts = batch.split(/^--- Event \d+ [^\n]*---\n/m).filter((p) => p.includes("Event ID:"));
  return parts[parts.length - 1];
}

function field(block: string, name: string): string | undefined {
  const m = block.match(new RegExp(`^${name}: (.*)$`, "m"));
  return m?.[1]?.trim();
}

/** Parse Buzz's text framing. Undefined when the prompt carries no `<buzz-event>` block. */
export function parseBuzzPrompt(text: string): { event: EventLike; channel: string } | undefined {
  const block = lastBlock(text, "buzz-event") ?? lastEventSegment(lastBlock(text, "buzz-events"));
  if (!block) return undefined;

  const idRaw = field(block, "Event ID");
  const id = idRaw && HEX64.test(idRaw) ? idRaw.toLowerCase() : syntheticId(text);
  const channelLine = field(block, "Channel") ?? field(lastBlock(text, "context") ?? "", "Channel") ?? "";
  const channel = channelLine.match(/#(?<id>[0-9a-f-]{36})/i)?.groups?.id?.toLowerCase() ?? channelLine.match(UUID)?.[0]?.toLowerCase() ?? "";
  const kindRaw = Number.parseInt(field(block, "Kind") ?? "", 10);
  const kind = Number.isFinite(kindRaw) ? kindRaw : 9;
  const fromLine = field(block, "From") ?? "";
  const pubkey = (fromLine.match(/hex: (?<hex>[0-9a-f]{64})/i)?.groups?.hex ?? fromLine.match(/[0-9a-f]{64}/i)?.[0] ?? "").toLowerCase();
  const timeRaw = field(block, "Time");
  const parsedTime = timeRaw ? Date.parse(timeRaw) : Number.NaN;
  const created_at = Number.isFinite(parsedTime) ? Math.floor(parsedTime / 1000) : Number.parseInt(timeRaw ?? "", 10) || Math.floor(Date.now() / 1000);
  // Content runs until the Tags/Parsed line or the end of the block (no `m` flag: `$` is end of input).
  const content = block.match(/(?:^|\n)Content: ([\s\S]*?)(?=\nTags: |\nParsed: |$)/)?.[1] ?? "";
  let tags: string[][] = [];
  const tagsRaw = field(block, "Tags");
  if (tagsRaw) {
    try {
      const parsed = JSON.parse(tagsRaw) as unknown;
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
