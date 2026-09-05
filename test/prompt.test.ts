import { describe, expect, test } from "bun:test";
import { parseBuzzPrompt, promptText, resolveEvent, syntheticId } from "../src/prompt";
import { CHANNEL, SENDER, buzzFramedPrompt } from "./helpers/acp-client";

const EVENT = "b".repeat(64);
const ROOT = "a".repeat(64);

describe("prompt text", () => {
  test("text blocks are joined with newlines; other block types and non-arrays are ignored", () => {
    expect(promptText([{ type: "text", text: "a" }, { type: "image", data: "…" }, { type: "text", text: "b" }])).toBe("a\nb");
    expect(promptText("nope")).toBe("");
    expect(promptText([{ type: "text", text: 5 }])).toBe("");
  });

  test("synthetic ids are 64 hex and stable for the same text", () => {
    expect(syntheticId("x")).toMatch(/^[0-9a-f]{64}$/);
    expect(syntheticId("x")).toBe(syntheticId("x"));
    expect(syntheticId("x")).not.toBe(syntheticId("y"));
  });
});

describe("Buzz text framing", () => {
  test("a <buzz-event> block yields id, channel, kind, sender hex, time, multi-line content and tags", () => {
    const p = parseBuzzPrompt(buzzFramedPrompt({ eventId: EVENT, channel: CHANNEL, sender: SENDER, content: "hello\nsecond line", threadRoot: ROOT }))!;
    expect(p.channel).toBe(CHANNEL);
    expect(p.event).toEqual({
      id: EVENT,
      kind: 9,
      pubkey: SENDER,
      content: "hello\nsecond line",
      tags: [["h", CHANNEL], ["e", ROOT, "", "root"], ["p", "c".repeat(64)]],
      created_at: Date.UTC(2026, 8, 5, 10) / 1000,
    });
  });

  test("uppercase ids are lowercased; a missing From hex leaves the sender empty; a bad Tags line is tolerated", () => {
    const text = `<buzz-event>\nEvent ID: ${EVENT.toUpperCase()}\nChannel: ${CHANNEL}\nKind: 45003\nFrom: someone\nTime: 1700000000\nContent: x\nTags: not json\n</buzz-event>`;
    const p = parseBuzzPrompt(text)!;
    expect(p.event.id).toBe(EVENT);
    expect(p.event.pubkey).toBe("");
    expect(p.event.kind).toBe(45003);
    expect(p.event.created_at).toBe(1_700_000_000);
    expect(p.event.tags).toEqual([["h", CHANNEL]]);
  });

  test("a <buzz-events> batch routes on its last event; the channel falls back to <context>", () => {
    const one = `Event ID: ${"1".repeat(64)}\nKind: 9\nFrom: (hex: ${SENDER})\nTime: 1\nContent: first\nTags: []`;
    const two = `Event ID: ${"2".repeat(64)}\nKind: 9\nFrom: (hex: ${SENDER})\nTime: 2\nContent: second\nTags: []`;
    const text = `<context>\nScope: channel\nChannel: general (#${CHANNEL})\n</context>\n\n<buzz-events>\n--- Event 1 (mention) ---\n${one}\n\n--- Event 2 (mention) ---\n${two}\n</buzz-events>`;
    const p = parseBuzzPrompt(text)!;
    expect(p.event.id).toBe("2".repeat(64));
    expect(p.event.content).toBe("second");
    expect(p.channel).toBe(CHANNEL);
    expect(p.event.tags).toEqual([["h", CHANNEL]]);
  });

  test("no framing → undefined", () => {
    expect(parseBuzzPrompt("just words")).toBeUndefined();
    expect(parseBuzzPrompt("<context>\nScope: channel\n</context>")).toBeUndefined();
  });
});

describe("event resolution", () => {
  test("_meta.buzz.events wins over the text; the last event routes; malformed entries fall through", () => {
    const meta = {
      buzz: {
        events: [
          { id: "1".repeat(64), kind: 9, pubkey: SENDER, content: "older", tags: [["h", CHANNEL]], created_at: 1 },
          { id: "2".repeat(64), kind: 9, pubkey: SENDER, content: "newest", tags: [["h", CHANNEL]], created_at: 2 },
        ],
      },
    };
    const r = resolveEvent(buzzFramedPrompt({ eventId: EVENT, channel: CHANNEL, sender: SENDER, content: "text" }), meta);
    expect(r.source).toBe("meta");
    expect(r.event).toMatchObject({ id: "2".repeat(64), content: "newest", pubkey: SENDER });
    expect(r.channel).toBe(CHANNEL);
    expect(r.events).toEqual(meta.buzz.events);
    const bad = resolveEvent(buzzFramedPrompt({ eventId: EVENT, channel: CHANNEL, sender: SENDER, content: "text" }), { buzz: { events: [{ id: "nope" }] } });
    expect(bad.source).toBe("text");
    expect(bad.event.id).toBe(EVENT);
  });

  test("plain text falls back to a synthetic event: sender unknown, the prompt as content, a stable id", () => {
    const r = resolveEvent("just some words", undefined);
    expect(r.source).toBe("synthetic");
    expect(r.channel).toBe("");
    expect(r.event).toMatchObject({ kind: 9, pubkey: "", content: "just some words", tags: [] });
    expect(r.event.id).toBe(syntheticId("just some words"));
  });
});
