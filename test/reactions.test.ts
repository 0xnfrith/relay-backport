import { describe, expect, test } from "bun:test";
import { configureLog } from "../src/log";
import { ReactionManager } from "../src/reactions";
import { CHANNEL_A, CHANNEL_B } from "./helpers/mock-relay";

configureLog({ writer: () => {} });

function manager(sweepAfterMs = 1000) {
  const published: { kind: number; tags: string[][]; content: string }[] = [];
  let n = 0;
  const m = new ReactionManager(
    async (tmpl) => {
      published.push(tmpl);
      return `reaction-${++n}`;
    },
    { sweepAfterMs },
  );
  return { m, published };
}

describe("reactions", () => {
  test("react publishes 👀 and 💬 on the trigger and is idempotent per trigger", async () => {
    const { m, published } = manager();
    await m.react("trigger-1", CHANNEL_A);
    await m.react("trigger-1", CHANNEL_A);
    expect(published).toEqual([
      { kind: 7, tags: [["e", "trigger-1"]], content: "👀" },
      { kind: 7, tags: [["e", "trigger-1"]], content: "💬" },
    ]);
    expect(m.pendingCount).toBe(1);
    expect(m.pendingFor("trigger-1")?.reactionIds).toEqual(["reaction-1", "reaction-2"]);
  });

  test("an own reply in the channel deletes the pending reactions there only", async () => {
    const { m, published } = manager();
    await m.react("t-a", CHANNEL_A);
    await m.react("t-b", CHANNEL_B);
    published.length = 0;
    expect(await m.onOwnReply(CHANNEL_A)).toBe(1);
    expect(published).toEqual([
      { kind: 5, tags: [["e", "reaction-1"]], content: "" },
      { kind: 5, tags: [["e", "reaction-2"]], content: "" },
    ]);
    expect(m.pendingCount).toBe(1);
    expect(await m.onOwnReply(CHANNEL_A)).toBe(0);
  });

  test("the sweep removes reactions older than the window", async () => {
    const { m, published } = manager(1000);
    await m.react("old", CHANNEL_A);
    const p = m.pendingFor("old")!;
    p.addedAt = Date.now() - 5000;
    await m.react("new", CHANNEL_A);
    published.length = 0;
    expect(await m.sweep()).toBe(1);
    expect(published.map((p) => p.kind)).toEqual([5, 5]);
    expect(m.pendingCount).toBe(1);
    expect(m.pendingFor("new")).toBeDefined();
  });

  test("a failed publish leaves nothing pending", async () => {
    const m = new ReactionManager(async () => null, { sweepAfterMs: 1000 });
    await m.react("t", CHANNEL_A);
    expect(m.pendingCount).toBe(0);
  });
});
