import { describe, expect, test } from "bun:test";
import {
  RingBuffer,
  buildRecord,
  recordFromPayload,
  startObserveServer,
  type ObserveRecord,
} from "../src/observe";
import type { EventLike } from "../src/mention";

function ev(over: Partial<EventLike> = {}): EventLike {
  return {
    id: "a".repeat(64),
    kind: 9,
    pubkey: "b".repeat(64),
    content: "hello",
    tags: [["h", "chan-1"]],
    created_at: 1_700_000_000,
    ...over,
  };
}

describe("RingBuffer", () => {
  test("keeps the newest items at capacity", () => {
    const b = new RingBuffer<number>(3);
    for (const n of [1, 2, 3, 4, 5]) b.push(n);
    expect(b.last()).toEqual([3, 4, 5]);
    expect(b.size).toBe(3);
  });

  test("last(n) clamps at both ends", () => {
    const b = new RingBuffer<number>(5);
    for (const n of [1, 2, 3]) b.push(n);
    expect(b.last(2)).toEqual([2, 3]);
    expect(b.last(99)).toEqual([1, 2, 3]);
    expect(b.last(0)).toEqual([]);
  });
});

describe("buildRecord", () => {
  test("a delivered record carries the MENTION| line verbatim", () => {
    const rec = buildRecord(1, { lane: "daemon", verdict: "delivered", event: ev(), emitted: true });
    expect(rec.mention_line).toStartWith("MENTION|");
    expect(JSON.parse(rec.mention_line!.slice("MENTION|".length)).id).toBe("a".repeat(64));
  });

  test("a dropped record emits no line", () => {
    const rec = buildRecord(1, { lane: "daemon", verdict: "dropped_self", event: ev() });
    expect(rec.mention_line).toBeNull();
    expect(rec.verdict).toBe("dropped_self");
  });

  test("delta_ms measures receive lag against created_at", () => {
    const rec = buildRecord(1, { lane: "daemon", verdict: "delivered", event: ev(), now: 1_700_000_002_500 });
    expect(rec.delta_ms).toBe(2500);
  });

  test("channel and thread root come from the tags", () => {
    const rec = buildRecord(1, {
      lane: "daemon",
      verdict: "delivered",
      event: ev({ tags: [["h", "chan-9"], ["e", "c".repeat(64), "", "root"]] }),
    });
    expect(rec.channel).toBe("chan-9");
    expect(rec.thread_root).toBe("c".repeat(64));
  });

  test("an unknown sender degrades rather than throwing", () => {
    const rec = buildRecord(1, { lane: "daemon", verdict: "delivered", event: ev({ pubkey: "" }) });
    expect(rec.from).toBe("unknown");
  });
});

describe("recordFromPayload", () => {
  test("a harness payload becomes a harness-lane record carrying the prompt", () => {
    const rec = recordFromPayload(7, {
      event_id: "d".repeat(64),
      author: "e".repeat(64),
      kind: 9,
      created_at: 1_700_000_000,
      text: "hi",
      tags: [["h", "chan-2"]],
      prompt: "<context>…</context>",
      event_source: "text",
      relay: "wss://relay.example",
    });
    expect(rec?.lane).toBe("harness");
    expect(rec?.verdict).toBe("delivered");
    expect(rec?.prompt).toBe("<context>…</context>");
    expect(rec?.channel).toBe("chan-2");
    expect(rec?.mention_line).toStartWith("MENTION|");
  });

  test("junk is rejected rather than rendered", () => {
    expect(recordFromPayload(1, null)).toBeUndefined();
    expect(recordFromPayload(1, {})).toBeUndefined();
    expect(recordFromPayload(1, { event_id: "" })).toBeUndefined();
  });
});

describe("observe server", () => {
  async function withServer(fn: (base: string, srv: ReturnType<typeof startObserveServer>) => Promise<void>) {
    const srv = startObserveServer({
      host: "127.0.0.1",
      port: 0,
      buffer: 3,
      daemonInfo: { label: "test", detail: "unit" },
    });
    try {
      await fn(`http://127.0.0.1:${srv.port}`, srv);
    } finally {
      srv.stop();
    }
  }

  test("serves a self-contained page with both column headers", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("v0.1 watch");
      expect(html).toContain("v0.2 acp");
      // no build step, no network: everything inline
      expect(html).not.toContain("<script src");
      expect(html).not.toContain("https://");
    });
  });

  test("/records returns both lanes in sequence order", async () => {
    await withServer(async (base, srv) => {
      srv.record({ lane: "daemon", verdict: "dropped_self", event: ev() });
      const posted = await fetch(`${base}/ingest?label=harness`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event_id: "f".repeat(64), kind: 9, text: "x", tags: [], prompt: "P" }),
      });
      expect(posted.status).toBe(200);
      const recs = (await (await fetch(`${base}/records`)).json()) as ObserveRecord[];
      expect(recs.map((r) => r.lane)).toEqual(["daemon", "harness"]);
      expect(recs.map((r) => r.seq)).toEqual([1, 2]);
      expect(recs[1]!.prompt).toBe("P");
    });
  });

  test("the ring buffer bounds each lane independently", async () => {
    await withServer(async (base, srv) => {
      for (let i = 0; i < 6; i++) srv.record({ lane: "daemon", verdict: "delivered", event: ev(), emitted: true });
      expect(srv.records("daemon")).toHaveLength(3);
      const recs = (await (await fetch(`${base}/records`)).json()) as ObserveRecord[];
      expect(recs).toHaveLength(3);
      expect(recs.map((r) => r.seq)).toEqual([4, 5, 6]);
    });
  });

  test("/ingest rejects junk without recording it", async () => {
    await withServer(async (base, srv) => {
      const bad = await fetch(`${base}/ingest`, { method: "POST", body: "not json" });
      expect(bad.status).toBe(400);
      expect(srv.records()).toHaveLength(0);
      const empty = await fetch(`${base}/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nope: true }),
      });
      expect(empty.status).toBe(400);
      expect(srv.records()).toHaveLength(0);
      // the rejected payloads must not have burned sequence numbers
      srv.record({ lane: "daemon", verdict: "delivered", event: ev(), emitted: true });
      expect(srv.records()[0]!.seq).toBe(1);
    });
  });

  test("/events replays the buffer then streams live records", async () => {
    await withServer(async (base, srv) => {
      srv.record({ lane: "daemon", verdict: "dropped_kind", reason: "kind 7", event: ev({ kind: 7 }) });
      const res = await fetch(`${base}/events`);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const reader = res.body!.getReader();
      const dec = new TextDecoder();

      const first = dec.decode((await reader.read()).value);
      expect(first).toContain('"verdict":"dropped_kind"');

      srv.record({ lane: "daemon", verdict: "delivered", event: ev(), emitted: true });
      let live = "";
      while (!live.includes("delivered")) live += dec.decode((await reader.read()).value);
      expect(live).toContain('"mention_line":"MENTION|');
      await reader.cancel();
    });
  });

  test("/config reports the daemon pane and learns the harness pane from traffic", async () => {
    await withServer(async (base) => {
      const before = (await (await fetch(`${base}/config`)).json()) as { daemon: { label: string }; harness: { label: string } };
      expect(before.daemon.label).toBe("test");
      expect(before.harness.label).toBe("harness lane");
      await fetch(`${base}/ingest?label=v0.2%20acp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event_id: "1".repeat(64), relay: "wss://relay.example", tags: [] }),
      });
      const after = (await (await fetch(`${base}/config`)).json()) as { harness: { label: string; detail: string } };
      expect(after.harness.label).toBe("v0.2 acp");
      expect(after.harness.detail).toBe("wss://relay.example");
    });
  });

  test("unknown routes 404", async () => {
    await withServer(async (base) => {
      expect((await fetch(`${base}/nope`)).status).toBe(404);
    });
  });
});
