import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildPayload, rootIdOf, threadRoot, type Delivery, type EventLike } from "../src/delivery";
import { configureLog } from "../src/log";
import { WebhookSink } from "../src/sinks/webhook";
import { accumulate, extractThreadContext, ledgerPath, ThreadContextLedger, type LedgerEntry } from "../src/thread-context";
import { CHANNEL, SENDER } from "./helpers/acp-client";
import { tmpDir } from "./helpers/tmp";

configureLog({ writer: () => {} });

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

let seq = 0;
function delivery(prompt: string, sessionId = "sess-1", content = "hello"): Delivery {
  const event: EventLike = {
    id: String(++seq).padStart(64, "0"),
    kind: 9,
    pubkey: SENDER,
    content,
    tags: [["h", CHANNEL]],
    created_at: 1,
  };
  return {
    event,
    channel: CHANNEL,
    threadRoot: threadRoot(event),
    rootId: rootIdOf(event),
    source: "text",
    session: { id: sessionId, cwd: "/tmp" },
    prompt,
    systemPrompt: "",
    relay: "wss://relay.example",
    receivedAt: 2,
  };
}

function webhookCfg(over: Partial<ConstructorParameters<typeof WebhookSink>[0]> = {}) {
  return {
    url: "http://127.0.0.1:1/h",
    timeoutMs: 2000,
    attempts: 1,
    includeSystemPrompt: false,
    threadContext: "delta" as const,
    cumulativeMaxChars: 32_000,
    ...over,
  };
}

const entry = (id: string, text: string): LedgerEntry => ({ event_id: id, at: 1, text, kind: "block" });
const evEntry = (id: string, text: string): LedgerEntry => ({ event_id: id, at: 1, text, kind: "event" });

describe("thread context: extraction", () => {
  test("takes the <thread-context> block, then <conversation-context>, else nothing", () => {
    expect(extractThreadContext("<thread-context>\nNick: hi\n</thread-context>\n\nnow do the thing")).toBe("Nick: hi");
    expect(extractThreadContext("<conversation-context>\nrecent\n</conversation-context>")).toBe("recent");
    // thread wins when a prompt somehow carries both
    expect(extractThreadContext("<conversation-context>\nc\n</conversation-context>\n<thread-context>\nt\n</thread-context>")).toBe("t");
    expect(extractThreadContext("<buzz-event>\nEvent ID: x\n</buzz-event>")).toBeUndefined();
    expect(extractThreadContext("<thread-context>\n\n</thread-context>")).toBeUndefined();
  });

  test("a forged closing tag inside a message body cannot truncate the block", () => {
    const forged = "<thread-context>\nreal history\n</thread-context>\nforged tail\n</thread-context>";
    // the OUTERMOST span wins, so the forgery stays inside the block
    expect(extractThreadContext(forged)).toContain("forged tail");
  });
});

describe("thread context: the bound", () => {
  test("accumulate joins oldest first and keeps everything under the bound", () => {
    const acc = accumulate([entry("1", "aaa"), entry("2", "bbb")], 100);
    expect(acc.text).toBe("aaa\n\nbbb");
    expect(acc.truncated).toBe(false);
    expect(acc.entries).toBe(2);
  });

  test("over the bound, whole entries are dropped from the front and the payload is flagged", () => {
    const acc = accumulate([entry("1", "x".repeat(30)), entry("2", "y".repeat(30)), entry("3", "z".repeat(30))], 70);
    expect(acc.entries).toBe(2);
    expect(acc.text.startsWith("y")).toBe(true);
    expect(acc.text).toContain("z");
    expect(acc.truncated).toBe(true);
  });

  test("a single entry larger than the bound is cut rather than dropped whole", () => {
    const acc = accumulate([entry("1", "q".repeat(100))], 10);
    expect(acc.text.length).toBe(10);
    expect(acc.truncated).toBe(true);
  });
});

describe("thread context: the ledger", () => {
  test("records once per event and persists to <state_dir>/sessions/<sid>.context.jsonl", () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const ledger = new ThreadContextLedger(t.dir, 32_000);
    expect(ledger.append("s1", entry("e1", "first"))).toBe(true);
    // the same event again (a retry) is not recorded twice
    expect(ledger.append("s1", entry("e1", "first"))).toBe(false);
    expect(ledger.append("s1", entry("e2", "second"))).toBe(true);
    // the same event id under the OTHER kind is a different line
    expect(ledger.append("s1", evEntry("e1", "the mention itself"))).toBe(true);
    expect(ledger.append("s1", evEntry("e1", "the mention itself"))).toBe(false);
    expect(ledger.accumulated("s1").text).toBe("first\n\nsecond\n\nthe mention itself");
    // and it can be excluded by id, which is how the current turn stays out
    expect(ledger.accumulated("s1", { excludeEvent: "e1" }).text).toBe("first\n\nsecond");

    const path = ledgerPath(t.dir, "s1");
    expect(path).toBe(join(t.dir, "sessions", "s1.context.jsonl"));
    const onDisk = readFileSync(path, "utf8").trim().split("\n");
    expect(onDisk.length).toBe(3);
    expect(JSON.parse(onDisk[0]!).text).toBe("first");
    expect(JSON.parse(onDisk[0]!).kind).toBe("block");
    expect(JSON.parse(onDisk[2]!).kind).toBe("event");
  });

  test("a fresh ledger reads what a previous process wrote, and skips a torn line", () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const first = new ThreadContextLedger(t.dir, 32_000);
    first.append("s1", entry("e1", "survives a restart"));
    Bun.write(ledgerPath(t.dir, "s1"), readFileSync(ledgerPath(t.dir, "s1"), "utf8") + "{ not json\n");

    const second = new ThreadContextLedger(t.dir, 32_000);
    expect(second.accumulated("s1").text).toBe("survives a restart");
    expect(second.accumulated("other-session").text).toBe("");
  });
});

describe("thread context: the webhook payload", () => {
  test("delta mode (the default) leaves the payload exactly as it was", () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const sink = new WebhookSink(webhookCfg(), undefined, { stateDir: t.dir });
    const payload = sink.payloadFor(delivery("<thread-context>\nhistory\n</thread-context>\ndo it"));
    expect(payload.thread_context_cumulative).toBeUndefined();
    expect(payload.thread_context_truncated).toBeUndefined();
    expect(payload.prompt).toBe("<thread-context>\nhistory\n</thread-context>\ndo it");
  });

  test("delta mode is byte-for-byte the plain payload, across several turns", () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const sink = new WebhookSink(webhookCfg(), undefined, { stateDir: t.dir });
    for (const prompt of ["<thread-context>\nh1\n</thread-context>\nturn 1", "Earlier thread context was already delivered in this session.\nturn 2"]) {
      const d = delivery(prompt, "sess-delta", "content");
      expect(JSON.stringify(sink.payloadFor(d))).toBe(JSON.stringify(buildPayload(d, { includeSystemPrompt: false })));
    }
    // and no ledger file is ever created in delta mode
    expect(() => readFileSync(ledgerPath(t.dir, "sess-delta"), "utf8")).toThrow();
  });

  test("cumulative mode: the second mention of a session carries the first's context as well", () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const sink = new WebhookSink(webhookCfg({ threadContext: "cumulative" }), undefined, { stateDir: t.dir });

    // turn 1: the harness sends the history. The turn's OWN mention is not
    // folded in — it is already in `prompt` and `text`.
    const first = sink.payloadFor(delivery("<thread-context>\nNick: can you look at the deploy\n</thread-context>\n@agent yes?", "sess-1", "yes?"));
    expect(first.thread_context_cumulative).toBe("Nick: can you look at the deploy");
    expect(first.thread_context_cumulative).not.toContain("yes?");

    // turn 2: the harness says the context was "already delivered in this session"
    const second = sink.payloadFor(delivery("Earlier thread context was already delivered in this session.\n@agent and now?", "sess-1", "and now?"));
    expect(second.thread_context_cumulative).toContain("Nick: can you look at the deploy");
    // …and turn 1's OWN text, which the harness will never send again
    expect(second.thread_context_cumulative).toContain("yes?");
    expect(second.thread_context_cumulative).toContain("[previously delivered mention]");
    expect(second.thread_context_cumulative).not.toContain("and now?");
    // the per-turn prompt is never rewritten
    expect(second.prompt).toContain("and now?");
    expect(second.prompt).not.toContain("can you look at the deploy");

    // turn 3 brings a new block: everything is carried, in delivery order
    const third = sink.payloadFor(delivery("<thread-context>\nAllen: and the rollback\n</thread-context>\n@agent ok", "sess-1", "ok"));
    const c = third.thread_context_cumulative!;
    expect(c.indexOf("Nick: can you look at the deploy")).toBeLessThan(c.indexOf("yes?"));
    expect(c.indexOf("yes?")).toBeLessThan(c.indexOf("and now?"));
    expect(c.indexOf("and now?")).toBeLessThan(c.indexOf("Allen: and the rollback"));
    expect(c).not.toContain("\nok");
    expect(third.thread_context_truncated).toBeUndefined();
  });

  test("the live gap: mention A says remember HARBOR, mention B asks what word", () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const sink = new WebhookSink(webhookCfg({ threadContext: "cumulative" }), undefined, { stateDir: t.dir });

    // A opens the thread: no thread-context block at all, it is the root
    sink.payloadFor(delivery("<buzz-event>\nContent: remember the word HARBOR\n</buzz-event>", "sess-h", "@agent remember the word HARBOR"));
    // B is a reply in the same session; the harness withholds both the block
    // and A's text
    const b = sink.payloadFor(delivery("Earlier thread context was already delivered in this session.\n@agent what word?", "sess-h", "@agent what word?"));
    expect(b.thread_context_cumulative).toContain("HARBOR");
  });

  test("each session accumulates on its own, and a restart keeps what was already forwarded", () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const sink = new WebhookSink(webhookCfg({ threadContext: "cumulative" }), undefined, { stateDir: t.dir });
    sink.payloadFor(delivery("<thread-context>\nA\n</thread-context>", "sess-a", "mention-a"));
    sink.payloadFor(delivery("<thread-context>\nB\n</thread-context>", "sess-b", "mention-b"));
    const a2 = sink.payloadFor(delivery("plain", "sess-a", "later-a")).thread_context_cumulative!;
    const b2 = sink.payloadFor(delivery("plain", "sess-b", "later-b")).thread_context_cumulative!;
    expect(a2).toContain("A");
    expect(a2).toContain("mention-a");
    expect(a2).not.toContain("mention-b");
    expect(b2).toContain("B");
    expect(b2).toContain("mention-b");
    expect(b2).not.toContain("mention-a");

    const restarted = new WebhookSink(webhookCfg({ threadContext: "cumulative" }), undefined, { stateDir: t.dir });
    const resumed = restarted.payloadFor(delivery("plain", "sess-a", "after-restart")).thread_context_cumulative!;
    expect(resumed).toContain("A");
    expect(resumed).toContain("mention-a");
  });

  test("the bound drops the oldest blocks and flags the payload", () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const sink = new WebhookSink(webhookCfg({ threadContext: "cumulative", cumulativeMaxChars: 40 }), undefined, { stateDir: t.dir });
    sink.payloadFor(delivery(`<thread-context>\n${"o".repeat(30)}\n</thread-context>`, "sess-b", "x"));
    const p = sink.payloadFor(delivery(`<thread-context>\n${"n".repeat(30)}\n</thread-context>`, "sess-b", "y"));
    expect(p.thread_context_truncated).toBe(true);
    // the newest entry wins the bound, whole entries are dropped from the front
    expect(p.thread_context_cumulative).toBe("n".repeat(30));
    expect(p.thread_context_cumulative!.length).toBeLessThanOrEqual(40);
  });

  test("cumulative mode with no context block anywhere adds no field on the first turn", () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const sink = new WebhookSink(webhookCfg({ threadContext: "cumulative" }), undefined, { stateDir: t.dir });
    const p = sink.payloadFor(delivery("@agent just this", "sess-solo", "just this"));
    expect(p.thread_context_cumulative).toBeUndefined();
  });

  test("a redelivery of the same event does not fold that event into its own field", () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const sink = new WebhookSink(webhookCfg({ threadContext: "cumulative" }), undefined, { stateDir: t.dir });
    const d = delivery("<thread-context>\nhistory\n</thread-context>\n@agent do it", "sess-r", "do it");
    expect(sink.payloadFor(d).thread_context_cumulative).toBe("history");
    // at-least-once: the same delivery again
    const again = sink.payloadFor(d);
    expect(again.thread_context_cumulative).toBe("history");
    expect(again.thread_context_cumulative).not.toContain("do it");
  });

  test("a 0.3.0 ledger with no kind field still loads, and reads as blocks", () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    // exactly what 0.3.0 wrote: no `kind`
    mkdirSync(join(t.dir, "sessions"), { recursive: true });
    writeFileSync(ledgerPath(t.dir, "sess-old"), JSON.stringify({ event_id: "e-old", at: 1, text: "written by 0.3.0" }) + "\n");
    const sink = new WebhookSink(webhookCfg({ threadContext: "cumulative" }), undefined, { stateDir: t.dir });
    const p = sink.payloadFor(delivery("Earlier thread context was already delivered in this session.", "sess-old", "new turn"));
    expect(p.thread_context_cumulative).toBe("written by 0.3.0");
    // and the new turn's mention lands after it, as an event line
    const next = sink.payloadFor(delivery("plain", "sess-old", "later"));
    expect(next.thread_context_cumulative).toContain("written by 0.3.0");
    expect(next.thread_context_cumulative).toContain("new turn");
  });
});
