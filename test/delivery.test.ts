import { describe, expect, test } from "bun:test";
import { buildMentionLine, buildPayload, formatMentionLine, rootIdOf, threadRoot, type Delivery, type EventLike } from "../src/delivery";
import { CHANNEL, SENDER } from "./helpers/acp-client";

const ROOT = "a".repeat(64);

function event(over: Partial<EventLike> = {}): EventLike {
  return { id: "b".repeat(64), kind: 9, pubkey: SENDER, content: "hi", tags: [["h", CHANNEL]], created_at: 1, ...over };
}

function delivery(ev: EventLike): Delivery {
  return {
    event: ev,
    channel: CHANNEL,
    threadRoot: threadRoot(ev),
    rootId: rootIdOf(ev),
    source: "text",
    session: { id: "s1", cwd: "/tmp", title: "general" },
    prompt: "the whole prompt",
    systemPrompt: "",
    relay: "wss://relay.example",
    receivedAt: 2,
  };
}

describe("MENTION| line (the v0.1 contract)", () => {
  test("shape and field order: kind, from (8 hex), h, content, id, tags", () => {
    const ev = event();
    expect(formatMentionLine(ev)).toBe(`MENTION|${JSON.stringify({ kind: 9, from: SENDER.slice(0, 8), h: CHANNEL, content: "hi", id: ev.id, tags: ev.tags })}`);
  });

  test("content is capped at 400 characters; an unknown sender prints as \"unknown\"; forum replies carry rootId", () => {
    const long = buildMentionLine(event({ content: "x".repeat(1000) }));
    expect(long.content.length).toBe(400);
    expect(buildMentionLine(event({ pubkey: "" })).from).toBe("unknown");
    const reply = buildMentionLine(event({ kind: 45003, tags: [["h", CHANNEL], ["e", ROOT]] }));
    expect(reply.rootId).toBe(ROOT);
    expect(buildMentionLine(event({ kind: 9, tags: [["h", CHANNEL], ["e", ROOT]] })).rootId).toBeUndefined();
  });

  test("thread root: root marker, else reply marker, else first e tag, else self", () => {
    expect(threadRoot(event({ tags: [["e", "1".repeat(64), "", "reply"], ["e", ROOT, "", "root"]] }))).toBe(ROOT);
    expect(threadRoot(event({ tags: [["e", ROOT, "", "reply"]] }))).toBe(ROOT);
    expect(threadRoot(event({ tags: [["e", ROOT]] }))).toBe(ROOT);
    expect(threadRoot(event())).toBe("b".repeat(64));
  });
});

describe("delivery payload (webhook + exec)", () => {
  test("carries the event, the whole prompt, the session and the source", () => {
    const ev = event({ kind: 45003, tags: [["h", CHANNEL], ["e", ROOT]] });
    const p = buildPayload(delivery(ev));
    expect(p).toEqual({
      source: "buzz",
      transport: "acp",
      relay: "wss://relay.example",
      channel: CHANNEL,
      event_id: ev.id,
      thread_root: ROOT,
      reply_to: ev.id,
      root_id: ROOT,
      author: SENDER,
      kind: 45003,
      created_at: 1,
      text: "hi",
      tags: ev.tags,
      event_source: "text",
      prompt: "the whole prompt",
      session: { id: "s1", cwd: "/tmp", title: "general" },
    });
  });

  test("events ride along only when the client sent them; root_id only for forum replies", () => {
    const d = delivery(event());
    expect("events" in buildPayload(d)).toBe(false);
    expect("root_id" in buildPayload(d)).toBe(false);
    const raw = [{ id: "x" }];
    expect(buildPayload({ ...d, events: raw }).events).toBe(raw);
  });

  test("system_prompt rides along only when the sink asks for it and the session had one", () => {
    const d = delivery(event());
    expect("system_prompt" in buildPayload(d)).toBe(false);
    expect("system_prompt" in buildPayload(d, { includeSystemPrompt: true })).toBe(false);
    const withPrompt = { ...d, systemPrompt: "be terse" };
    expect("system_prompt" in buildPayload(withPrompt)).toBe(false);
    expect(buildPayload(withPrompt, { includeSystemPrompt: true }).system_prompt).toBe("be terse");
    expect(buildPayload(withPrompt, { includeSystemPrompt: false }).system_prompt).toBeUndefined();
  });
});
