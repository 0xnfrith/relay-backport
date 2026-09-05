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

/** The `MENTION|{json}` payload. Field order and truncation are the contract. */
export type MentionLine = {
  kind: number;
  from: string;
  h: string;
  content: string;
  id: string;
  tags: string[][];
  rootId?: string;
};

export const MENTION_CONTENT_MAX = 400;
export const UNKNOWN_SENDER = "unknown";

export function buildMentionLine(ev: EventLike): MentionLine {
  const rootId = rootIdOf(ev);
  return {
    kind: ev.kind,
    from: ev.pubkey ? ev.pubkey.slice(0, 8) : UNKNOWN_SENDER,
    h: channelOf(ev),
    content: (ev.content ?? "").slice(0, MENTION_CONTENT_MAX),
    id: ev.id,
    tags: ev.tags,
    ...(rootId ? { rootId } : {}),
  };
}

export function formatMentionLine(ev: EventLike): string {
  return `MENTION|${JSON.stringify(buildMentionLine(ev))}`;
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
};

export function buildPayload(d: Delivery): DeliveryPayload {
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
  };
}
