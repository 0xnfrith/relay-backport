// The delivery record — what every sink receives for one ACP prompt — and
// the two wire shapes built from it: the `MENTION|{json}` line (frozen since
// v0.1 so an existing consumer keeps working) and the JSON payload the
// webhook and exec sinks carry.

/** The Buzz event behind a prompt, in Nostr shape. `pubkey` may be empty when unknown. */
export type EventLike = {
  id: string;
  kind: number;
  pubkey: string;
  content: string;
  tags: string[][];
  created_at: number;
};

/** Where the event fields came from. */
export type EventSource = "meta" | "text" | "synthetic";

export type SessionInfo = { id: string; cwd: string; title?: string };

export type Delivery = {
  event: EventLike;
  channel: string;
  threadRoot: string;
  rootId?: string;
  source: EventSource;
  session: SessionInfo;
  /** The prompt's text blocks, joined, verbatim. */
  prompt: string;
  /** `_meta.buzz.events[]` as the client sent it, when it did. */
  events?: unknown[];
  /**
   * The `session/new` system prompt, verbatim, or "" when the client sent
   * none. Carried on every delivery in the session so a sink can forward it
   * without keeping session state of its own. Never logged.
   */
  systemPrompt: string;
  /** `BUZZ_RELAY_URL` as injected by the harness, or "". */
  relay: string;
  receivedAt: number;
};

export const KIND_FORUM_REPLY = 45003;

export function tagValue(ev: Pick<EventLike, "tags">, name: string): string | undefined {
  for (const t of ev.tags ?? []) if (t[0] === name && t[1]) return t[1];
  return undefined;
}

export function channelOf(ev: Pick<EventLike, "tags">): string {
  return tagValue(ev, "h") ?? "";
}

/** Forum replies carry the root post id in their first `e` tag. */
export function rootIdOf(ev: Pick<EventLike, "kind" | "tags">): string | undefined {
  if (ev.kind !== KIND_FORUM_REPLY) return undefined;
  return tagValue(ev, "e");
}

/** Thread root: `e` marker=root, else marker=reply, else first `e`, else self. */
export function threadRoot(ev: Pick<EventLike, "id" | "tags">): string {
  const eTags = (ev.tags ?? []).filter((t) => t[0] === "e" && t[1]);
  const root = eTags.find((t) => t[3] === "root");
  if (root?.[1]) return root[1];
  const reply = eTags.find((t) => t[3] === "reply");
  if (reply?.[1]) return reply[1];
  if (eTags[0]?.[1]) return eTags[0][1];
  return ev.id;
}

/**
 * The `MENTION|{json}` payload. Field order is the contract: an untruncated
 * line is byte-identical to every version since v0.1. `truncated` is present
 * only when a cap actually cut the content short.
 */
export type MentionLine = {
  kind: number;
  from: string;
  h: string;
  content: string;
  id: string;
  tags: string[][];
  rootId?: string;
  truncated?: true;
};

export const UNKNOWN_SENDER = "unknown";

/**
 * `content` is delivered whole by default. `maxChars` > 0 caps it — and a cap
 * that actually bites sets `truncated: true`, so a consumer can tell a short
 * message from a clipped one. 0 (the default) means unlimited: the MENTION
 * line is the delivery channel into a session, not a preview of it, so
 * dropping the tail of a long message drops instructions.
 */
export function buildMentionLine(ev: EventLike, maxChars = 0): MentionLine {
  const rootId = rootIdOf(ev);
  const full = ev.content ?? "";
  const capped = maxChars > 0 && full.length > maxChars;
  return {
    kind: ev.kind,
    from: ev.pubkey ? ev.pubkey.slice(0, 8) : UNKNOWN_SENDER,
    h: channelOf(ev),
    content: capped ? full.slice(0, maxChars) : full,
    id: ev.id,
    tags: ev.tags,
    ...(rootId ? { rootId } : {}),
    ...(capped ? { truncated: true as const } : {}),
  };
}

export function formatMentionLine(ev: EventLike, maxChars = 0): string {
  return `MENTION|${JSON.stringify(buildMentionLine(ev, maxChars))}`;
}

/** The JSON the webhook POSTs and the exec hook reads on stdin. */
export type DeliveryPayload = {
  source: "buzz";
  transport: "acp";
  relay: string;
  channel: string;
  event_id: string;
  thread_root: string;
  reply_to: string;
  root_id?: string;
  author: string;
  kind: number;
  created_at: number;
  text: string;
  tags: string[][];
  event_source: EventSource;
  prompt: string;
  session: SessionInfo;
  events?: unknown[];
  /** The `session/new` system prompt, verbatim — only when the sink asked for it. */
  system_prompt?: string;
  /**
   * Every `<thread-context>` block this ACP session has carried AND every
   * mention already delivered in it, oldest first, for a receiver that keeps
   * no state of its own. The current turn's own mention is not repeated here
   * — it is already in `prompt` and `text`. Only in `cumulative` mode;
   * absent in the default `delta` mode, which leaves the payload byte-identical
   * to 0.2.x. `prompt` is never rewritten — this is additive.
   */
  thread_context_cumulative?: string;
  /** True when the bound dropped the oldest entries from `thread_context_cumulative`. */
  thread_context_truncated?: boolean;
};

export type BuildPayloadOptions = {
  /** Include `system_prompt` (verbatim, ~20-40 KB) when the delivery carries one. */
  includeSystemPrompt?: boolean;
  /** The accumulated thread context, when the sink is in `cumulative` mode. */
  threadContextCumulative?: string;
  threadContextTruncated?: boolean;
};

export function buildPayload(d: Delivery, opts: BuildPayloadOptions = {}): DeliveryPayload {
  return {
    source: "buzz",
    transport: "acp",
    relay: d.relay,
    channel: d.channel,
    event_id: d.event.id,
    thread_root: d.threadRoot,
    reply_to: d.event.id,
    ...(d.rootId ? { root_id: d.rootId } : {}),
    author: d.event.pubkey,
    kind: d.event.kind,
    created_at: d.event.created_at,
    text: d.event.content,
    tags: d.event.tags,
    event_source: d.source,
    prompt: d.prompt,
    session: d.session,
    ...(d.events ? { events: d.events } : {}),
    ...(opts.includeSystemPrompt && d.systemPrompt ? { system_prompt: d.systemPrompt } : {}),
    ...(opts.threadContextCumulative
      ? { thread_context_cumulative: opts.threadContextCumulative, ...(opts.threadContextTruncated ? { thread_context_truncated: true } : {}) }
      : {}),
  };
}
