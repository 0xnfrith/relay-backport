import { describe, expect, test } from "bun:test";
import {
  buildMentionLine,
  classify,
  formatMentionLine,
  matchesMentionText,
  membershipAction,
  mergeDiscoveredChannels,
  threadRoot,
  isEphemeralKind,
} from "../src/mention";
import { CHANNEL_A, channelMessage, keypair, membersEvent, metadataEvent, sign, now } from "./helpers/mock-relay";

const self = keypair();
const owner = keypair();
const other = keypair();

describe("mention classification", () => {
  test("p-tag of our key counts as a mention from anyone", () => {
    const ev = channelMessage(other.sk, CHANNEL_A, "hello", [["p", self.pk]]);
    const c = classify(ev, { selfPubkey: self.pk, ownerPubkey: owner.pk, mentionText: "@bot" });
    expect(c.ptag).toBe(true);
    expect(c.text).toBe(false);
    expect(c.fromOwner).toBe(false);
    expect(c.channel).toBe(CHANNEL_A);
  });

  test("literal mention text counts only for the owner", () => {
    const fromOwner = channelMessage(owner.sk, CHANNEL_A, "@bot do the thing");
    const fromOther = channelMessage(other.sk, CHANNEL_A, "@bot do the thing");
    const opts = { selfPubkey: self.pk, ownerPubkey: owner.pk, mentionText: "@bot" };
    expect(classify(fromOwner, opts).text).toBe(true);
    expect(classify(fromOther, opts).text).toBe(false);
  });

  test("p-tag of a different key is not a mention", () => {
    const ev = channelMessage(other.sk, CHANNEL_A, "hello", [["p", owner.pk]]);
    expect(classify(ev, { selfPubkey: self.pk }).ptag).toBe(false);
  });

  test("own messages are flagged fromSelf", () => {
    const ev = channelMessage(self.sk, CHANNEL_A, "reply", [["p", owner.pk]]);
    expect(classify(ev, { selfPubkey: self.pk }).fromSelf).toBe(true);
  });

  test("mention text is a whole-word, case-insensitive match", () => {
    expect(matchesMentionText("hey @Bot please", "@bot")).toBe(true);
    expect(matchesMentionText("@bot", "@bot")).toBe(true);
    expect(matchesMentionText("@bot2 no", "@bot")).toBe(false);
    expect(matchesMentionText("mail@bot.example", "@bot")).toBe(false);
    expect(matchesMentionText("robot", "bot")).toBe(false);
    expect(matchesMentionText("anything", undefined)).toBe(false);
  });

  test("ephemeral kinds are recognised", () => {
    expect(isEphemeralKind(20002)).toBe(true);
    expect(isEphemeralKind(9)).toBe(false);
    expect(isEphemeralKind(30000)).toBe(false);
  });
});

describe("MENTION line contract", () => {
  test("has exactly the monitor's fields, in order, with truncation", () => {
    const long = "x".repeat(500);
    const ev = channelMessage(owner.sk, CHANNEL_A, long, [["p", self.pk]]);
    const line = buildMentionLine(ev);
    expect(Object.keys(line)).toEqual(["kind", "from", "h", "content", "id", "tags"]);
    expect(line.from).toBe(owner.pk.slice(0, 8));
    expect(line.content.length).toBe(400);
    expect(line.h).toBe(CHANNEL_A);
    expect(formatMentionLine(ev).startsWith("MENTION|{")).toBe(true);
    expect(JSON.parse(formatMentionLine(ev).slice("MENTION|".length))).toEqual(line);
  });

  test("forum replies (45003) carry rootId from their e tag", () => {
    const root = "f".repeat(64);
    const ev = channelMessage(owner.sk, CHANNEL_A, "reply", [["e", root], ["p", self.pk]], 45003);
    const line = buildMentionLine(ev);
    expect(line.rootId).toBe(root);
    expect(Object.keys(line).at(-1)).toBe("rootId");
    const plain = channelMessage(owner.sk, CHANNEL_A, "msg", [["e", root]]);
    expect(buildMentionLine(plain).rootId).toBeUndefined();
  });
});

describe("thread root", () => {
  test("prefers root marker, then reply, then first e, then self", () => {
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    const withRoot = sign(other.sk, { kind: 9, created_at: now(), content: "", tags: [["e", b, "", "reply"], ["e", a, "", "root"]] });
    expect(threadRoot(withRoot)).toBe(a);
    const withReply = sign(other.sk, { kind: 9, created_at: now(), content: "", tags: [["e", b, "", "reply"]] });
    expect(threadRoot(withReply)).toBe(b);
    const bare = sign(other.sk, { kind: 9, created_at: now(), content: "", tags: [["e", a]] });
    expect(threadRoot(bare)).toBe(a);
    const none = sign(other.sk, { kind: 9, created_at: now(), content: "", tags: [] });
    expect(threadRoot(none)).toBe(none.id);
  });
});

describe("membership + discovery", () => {
  const relay = keypair();

  test("44100 with h tag and p tag → join; 44101 → leave", () => {
    const join = sign(relay.sk, { kind: 44100, created_at: 100, content: "", tags: [["p", self.pk], ["h", CHANNEL_A]] });
    expect(membershipAction(join, self.pk)).toEqual({ type: "join", channelId: CHANNEL_A, since: 100 });
    const leave = sign(relay.sk, { kind: 44101, created_at: 101, content: "", tags: [["p", self.pk], ["h", CHANNEL_A]] });
    expect(membershipAction(leave, self.pk)).toEqual({ type: "leave", channelId: CHANNEL_A });
  });

  test("44100 with JSON content (channel_id) is understood; other keys ignored", () => {
    const join = sign(relay.sk, {
      kind: 44100,
      created_at: 100,
      content: JSON.stringify({ channel_id: CHANNEL_A, pubkey: self.pk }),
      tags: [["p", self.pk]],
    });
    expect(membershipAction(join, self.pk)).toEqual({ type: "join", channelId: CHANNEL_A, since: 100 });
    const notUs = sign(relay.sk, { kind: 44100, created_at: 100, content: "", tags: [["p", other.pk], ["h", CHANNEL_A]] });
    expect(membershipAction(notUs, self.pk)).toEqual({ type: "ignore" });
    const wrongKind = sign(relay.sk, { kind: 9, created_at: 100, content: "", tags: [["p", self.pk], ["h", CHANNEL_A]] });
    expect(membershipAction(wrongKind, self.pk)).toEqual({ type: "ignore" });
  });

  test("39002 members minus archived 39000 metadata, deduplicated", () => {
    const members = [
      membersEvent(relay.sk, CHANNEL_A, [self.pk]),
      membersEvent(relay.sk, CHANNEL_A, [self.pk, other.pk]),
      membersEvent(relay.sk, "cccccccc-cccc-4ccc-8ccc-cccccccccccc", [self.pk]),
    ];
    const metas = [metadataEvent(relay.sk, "cccccccc-cccc-4ccc-8ccc-cccccccccccc", true)];
    expect(mergeDiscoveredChannels(members, metas)).toEqual([CHANNEL_A]);
  });
});
