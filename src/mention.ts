// Pure event classification: what counts as a mention, which channel/thread
// an event belongs to, and the exact stdout line shape consumers rely on.
import type { Event } from "nostr-tools";

export const KIND_CHANNEL_MESSAGE = 9;
export const KIND_FORUM_POST = 45001;
export const KIND_FORUM_REPLY = 45003;
export const KIND_REACTION = 7;
export const KIND_DELETION = 5;
export const KIND_AUTH = 22242;
export const KIND_GROUP_METADATA = 39000;
export const KIND_GROUP_MEMBERS = 39002;
export const KIND_MEMBER_ADDED = 44100;
export const KIND_MEMBER_REMOVED = 44101;
export const KIND_PUT_USER = 9000;
export const KIND_REMOVE_USER = 9001;

export const MEMBERSHIP_KINDS = [KIND_MEMBER_ADDED, KIND_MEMBER_REMOVED, KIND_PUT_USER, KIND_REMOVE_USER];

export type EventLike = Pick<Event, "id" | "kind" | "pubkey" | "content" | "tags" | "created_at">;

export function isEphemeralKind(kind: number): boolean {
  return kind >= 20000 && kind < 30000;
}

export function tagValue(ev: Pick<Event, "tags">, name: string): string | undefined {
  for (const t of ev.tags ?? []) if (t[0] === name && t[1]) return t[1];
  return undefined;
}

export function channelOf(ev: Pick<Event, "tags">): string {
  return tagValue(ev, "h") ?? "";
}

export function dTag(ev: Pick<Event, "tags">): string {
  return tagValue(ev, "d") ?? "";
}

export function hasPTag(ev: Pick<Event, "tags">, pubkey: string): boolean {
  const pk = pubkey.toLowerCase();
  return (ev.tags ?? []).some((t) => t[0] === "p" && t[1]?.toLowerCase() === pk);
}

/** Forum replies carry the root post id in their first `e` tag. */
export function rootIdOf(ev: Pick<Event, "kind" | "tags">): string | undefined {
  if (ev.kind !== KIND_FORUM_REPLY) return undefined;
  return tagValue(ev, "e");
}

/** Thread root: `e` marker=root, else marker=reply, else first `e`, else self. */
export function threadRoot(ev: Pick<Event, "id" | "tags">): string {
  const eTags = (ev.tags ?? []).filter((t) => t[0] === "e" && t[1]);
  const root = eTags.find((t) => t[3] === "root");
  if (root?.[1]) return root[1];
  const reply = eTags.find((t) => t[3] === "reply");
  if (reply?.[1]) return reply[1];
  if (eTags[0]?.[1]) return eTags[0][1];
  return ev.id;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Literal mention text match: the configured token as a whole word,
 * case-insensitive. "@name" must not match "@name2" or "someone@name".
 */
export function matchesMentionText(content: string, mentionText: string | undefined): boolean {
  if (!mentionText) return false;
  const re = new RegExp(`(^|[^\\w@])${escapeRegExp(mentionText)}(?![\\w-])`, "i");
  return re.test(content ?? "");
}

export type Classification = {
  /** The event p-tags our key. */
  ptag: boolean;
  /** The event contains the literal mention text (only evaluated for the owner). */
  text: boolean;
  fromOwner: boolean;
  fromSelf: boolean;
  channel: string;
  rootId?: string;
};

export function classify(
  ev: EventLike,
  opts: { selfPubkey: string; ownerPubkey?: string; mentionText?: string },
): Classification {
  const fromSelf = ev.pubkey.toLowerCase() === opts.selfPubkey.toLowerCase();
  const fromOwner = Boolean(opts.ownerPubkey) && ev.pubkey.toLowerCase() === opts.ownerPubkey!.toLowerCase();
  return {
    ptag: hasPTag(ev, opts.selfPubkey),
    text: fromOwner && matchesMentionText(ev.content, opts.mentionText),
    fromOwner,
    fromSelf,
    channel: channelOf(ev),
    rootId: rootIdOf(ev),
  };
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

export function buildMentionLine(ev: EventLike): MentionLine {
  const rootId = rootIdOf(ev);
  return {
    kind: ev.kind,
    from: ev.pubkey.slice(0, 8),
    h: channelOf(ev),
    content: (ev.content ?? "").slice(0, 400),
    id: ev.id,
    tags: ev.tags,
    ...(rootId ? { rootId } : {}),
  };
}

export function formatMentionLine(ev: EventLike): string {
  return `MENTION|${JSON.stringify(buildMentionLine(ev))}`;
}

/** A mention that passed classification and the allowlist; what sinks receive. */
export type MentionRecord = {
  event: EventLike;
  relay: string;
  channel: string;
  threadRoot: string;
  rootId?: string;
  ptag: boolean;
  text: boolean;
  fromOwner: boolean;
  /** Why the allowlist let it through. */
  allowedBy: "owner" | "ptag" | "any";
  receivedAt: number;
};

/** Membership notification → join/leave action for our key. */
export type MembershipAction =
  | { type: "join"; channelId: string; since: number }
  | { type: "leave"; channelId: string }
  | { type: "ignore" };

export function membershipAction(ev: EventLike, selfPubkey: string): MembershipAction {
  if (!MEMBERSHIP_KINDS.includes(ev.kind)) return { type: "ignore" };
  const pk = selfPubkey.toLowerCase();
  let aboutUs = hasPTag(ev, selfPubkey);
  let channelId = channelOf(ev);
  // Some relays put the payload in JSON content rather than tags.
  if ((!aboutUs || !channelId) && ev.content) {
    try {
      const body = JSON.parse(ev.content) as { channel_id?: string; pubkey?: string; member?: string };
      if (!channelId && typeof body.channel_id === "string") channelId = body.channel_id;
      if (!aboutUs) {
        const who = (body.pubkey ?? body.member ?? "").toLowerCase();
        aboutUs = who === pk || ev.content.toLowerCase().includes(pk);
      }
    } catch {
      // not JSON
    }
  }
  if (!aboutUs || !channelId) return { type: "ignore" };
  if (ev.kind === KIND_MEMBER_ADDED || ev.kind === KIND_PUT_USER) {
    return { type: "join", channelId, since: ev.created_at };
  }
  return { type: "leave", channelId };
}

export function isArchivedMetadata(ev: Pick<Event, "tags">): boolean {
  return (ev.tags ?? []).some((t) => t[0] === "archived" && t[1] === "true");
}

/** kind:39002 membership events + kind:39000 metadata → live channel ids. */
export function mergeDiscoveredChannels(
  memberEvents: Pick<Event, "kind" | "tags">[],
  metaEvents: Pick<Event, "kind" | "tags">[],
): string[] {
  const archived = new Set<string>();
  for (const ev of metaEvents) {
    if (ev.kind !== KIND_GROUP_METADATA) continue;
    const id = dTag(ev);
    if (id && isArchivedMetadata(ev)) archived.add(id);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const ev of memberEvents) {
    if (ev.kind !== KIND_GROUP_MEMBERS) continue;
    const id = dTag(ev);
    if (!id || seen.has(id) || archived.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
