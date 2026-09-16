import { afterEach, describe, expect, test } from "bun:test";
import { configureLog } from "../src/log";
import {
  DEFAULT_BIND,
  MAX_INGEST_BYTES,
  RingBuffer,
  SessionLedger,
  byteLength,
  estimateTokens,
  isLoopbackHost,
  parsePayload,
  renderPage,
  startObserveServer,
  type ObserveRecord,
  type ObserveServer,
} from "../src/observe";

configureLog({ writer: () => {} });

const servers: ObserveServer[] = [];
afterEach(() => {
  while (servers.length) servers.pop()?.stop();
});

/** Always port 0: a fixed port would collide with a parallel run or a live observe. */
function serve(opts: { buffer?: number; now?: () => number } = {}): ObserveServer {
  const s = startObserveServer({ host: DEFAULT_BIND, port: 0, ...opts });
  servers.push(s);
  return s;
}

const EVENT_ID = "a".repeat(64);
const AUTHOR = "b".repeat(64);

function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: "buzz",
    transport: "acp",
    relay: "wss://relay.example.com",
    channel: "00000000-0000-4000-8000-000000000001",
    event_id: EVENT_ID,
    thread_root: EVENT_ID,
    reply_to: EVENT_ID,
    author: AUTHOR,
    kind: 9,
    created_at: 1_700_000_000,
    text: "hello there",
    tags: [["h", "00000000-0000-4000-8000-000000000001"]],
    event_source: "text",
    prompt: "<buzz-event>…</buzz-event>\nhello there",
    session: { id: "sess-1", cwd: "/tmp/work", title: "a thread" },
    ...over,
  };
}

async function post(port: number, body: unknown): Promise<Response> {
  return fetch(`http://${DEFAULT_BIND}:${port}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("token estimate math", () => {
  test("chars/4, rounded up; empty is zero; bytes counts UTF-8", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("x".repeat(40_000))).toBe(10_000);
    expect(byteLength("abc")).toBe(3);
    expect(byteLength("é")).toBe(2);
  });
});

describe("ring buffer bounds", () => {
  test("keeps the last `capacity` items in arrival order", () => {
    const r = new RingBuffer<number>(3);
    for (let i = 1; i <= 5; i++) r.push(i);
    expect(r.size).toBe(3);
    expect(r.last()).toEqual([3, 4, 5]);
    expect(r.last(2)).toEqual([4, 5]);
    expect(r.last(99)).toEqual([3, 4, 5]);
    expect(r.last(0)).toEqual([]);
  });
});

describe("session accounting", () => {
  test("the system prompt is counted ONCE per session, the prompt every turn", () => {
    const ledger = new SessionLedger();
    const system = "S".repeat(40_000); // ~10k tokens, re-sent on every POST by the webhook sink
    const prompt = "P".repeat(400); // 100 tokens
    let totals;
    for (let i = 0; i < 3; i++) {
      const p = parsePayload(payload({ prompt, system_prompt: system }), 1_700_000_100_000)!;
      totals = ledger.add(p).totals;
    }
    expect(totals!.turns).toBe(3);
    expect(totals!.prompt_tokens).toBe(300);
    expect(totals!.system_prompt_tokens).toBe(10_000);
    expect(totals!.total_tokens).toBe(10_300); // not 3 × 10_000
  });

  test("a changed system prompt is counted again; only the first turn carries it in turn_tokens", () => {
    const ledger = new SessionLedger();
    const first = ledger.add(parsePayload(payload({ prompt: "abcd", system_prompt: "xyzw" }))!);
    expect(first.sizes.turn_tokens).toBe(2); // 1 prompt + 1 new system prompt
    const second = ledger.add(parsePayload(payload({ prompt: "abcd", system_prompt: "xyzw" }))!);
    expect(second.sizes.turn_tokens).toBe(1); // same system prompt: not charged again
    const third = ledger.add(parsePayload(payload({ prompt: "abcd", system_prompt: "different!" }))!);
    expect(third.sizes.turn_tokens).toBe(4); // 1 prompt + 3 for the new standing block
    expect(third.totals.system_prompt_tokens).toBe(4);
  });

  test("sessions are accounted separately; a payload with no session id gets its own bucket", () => {
    const ledger = new SessionLedger();
    ledger.add(parsePayload(payload({ prompt: "abcd" }))!);
    ledger.add(parsePayload(payload({ prompt: "abcdabcd", session: { id: "sess-2", cwd: "/tmp" } }))!);
    ledger.add(parsePayload(payload({ prompt: "abcd", session: {} }))!);
    const all = ledger.all().sort((a, b) => a.session_id.localeCompare(b.session_id));
    expect(all.map((t) => t.session_id)).toEqual(["(no session)", "sess-1", "sess-2"]);
    expect(ledger.get("sess-2")!.total_tokens).toBe(2);
  });
});

describe("payload parsing", () => {
  test("reads an allowlist of fields; nothing else survives", () => {
    const rec = parsePayload(payload({ BUZZ_PRIVATE_KEY: "nsec1definitelynot", extra: { a: 1 } }), 1_700_000_005_000)!;
    expect(rec.event_id).toBe(EVENT_ID);
    expect(rec.from).toBe("bbbbbbbb");
    expect(rec.session_id).toBe("sess-1");
    expect(rec.relay).toBe("wss://relay.example.com");
    expect(rec.delta_ms).toBe(5000);
    expect(JSON.stringify(rec)).not.toContain("BUZZ_PRIVATE_KEY");
    expect(JSON.stringify(rec)).not.toContain("nsec1");
  });

  test("missing or nonsensical fields degrade instead of throwing", () => {
    const rec = parsePayload({ event_id: EVENT_ID, prompt: "" })!;
    expect(rec.created_at).toBeNull();
    expect(rec.delta_ms).toBeNull();
    expect(rec.from).toBe("unknown");
    expect(rec.kind).toBe(0);
    expect(rec.tags).toEqual([]);
    expect(rec.thread_root).toBe(EVENT_ID);
    expect(rec.system_prompt).toBe("");
    const zero = parsePayload({ event_id: EVENT_ID, prompt: "x", created_at: 0 })!;
    expect(zero.delta_ms).toBeNull();
  });

  test("a body that is not a delivery is rejected", () => {
    expect(parsePayload(undefined)).toBeUndefined();
    expect(parsePayload("a string")).toBeUndefined();
    expect(parsePayload([])).toBeUndefined();
    expect(parsePayload({})).toBeUndefined();
    expect(parsePayload({ event_id: EVENT_ID })).toBeUndefined(); // no prompt
    expect(parsePayload({ prompt: "x" })).toBeUndefined(); // no event id
  });

  test("channel and thread root fall back to the tags", () => {
    const rec = parsePayload({
      event_id: EVENT_ID,
      prompt: "x",
      tags: [
        ["h", "chan-uuid"],
        ["e", "c".repeat(64), "", "root"],
        "not-a-tag",
      ],
    })!;
    expect(rec.channel).toBe("chan-uuid");
    expect(rec.thread_root).toBe("c".repeat(64));
    expect(rec.tags).toEqual([
      ["h", "chan-uuid"],
      ["e", "c".repeat(64), "", "root"],
    ]);
  });
});

describe("/ingest validation", () => {
  test("junk is 400 and never burns a sequence number", async () => {
    const s = serve();
    expect((await post(s.port, "{not json")).status).toBe(400);
    expect((await post(s.port, { hello: "world" })).status).toBe(400);
    expect((await post(s.port, [1, 2, 3])).status).toBe(400);
    expect(s.records()).toEqual([]);

    const ok = await post(s.port, payload());
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, seq: 1 });

    expect((await post(s.port, { nope: true })).status).toBe(400);
    const second = await post(s.port, payload());
    expect(await second.json()).toEqual({ ok: true, seq: 2 });
  });

  test("a body over the cap is 413 and is never buffered", async () => {
    const s = serve();
    const huge = JSON.stringify({ event_id: EVENT_ID, prompt: "X".repeat(MAX_INGEST_BYTES + 1024) });
    expect(huge.length).toBeGreaterThan(MAX_INGEST_BYTES);
    const res = await post(s.port, huge);
    expect(res.status).toBe(413);
    expect(s.records()).toEqual([]);
    expect(s.sessions()).toEqual([]);
    // A streamed body that declares no content-length is capped the same way:
    // Bun's own maxRequestBodySize does not stop a chunked POST.
    const chunked = await fetch(`http://${DEFAULT_BIND}:${s.port}/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      duplex: "half",
      body: new ReadableStream<Uint8Array>({
        start(c) {
          const chunk = new TextEncoder().encode("X".repeat(64 * 1024));
          for (let i = 0; i < 24; i++) c.enqueue(chunk); // 1.5 MiB, no length header
          c.close();
        },
      }),
    } as RequestInit);
    expect(chunked.status).toBe(413);
    expect(s.records()).toEqual([]);

    // …and a body just under the cap still goes through.
    const ok = await post(s.port, payload({ prompt: "P".repeat(1000) }));
    expect(ok.status).toBe(200);
  });

  test("unknown paths are 404 and GET /ingest is not accepted", async () => {
    const s = serve();
    expect((await fetch(`http://${DEFAULT_BIND}:${s.port}/nope`)).status).toBe(404);
    expect((await fetch(`http://${DEFAULT_BIND}:${s.port}/ingest`)).status).toBe(404);
  });

  test("the ring buffer bounds what the server retains", async () => {
    const s = serve({ buffer: 2 });
    for (let i = 0; i < 4; i++) await post(s.port, payload({ prompt: `turn ${i}` }));
    const recs = s.records();
    expect(recs.length).toBe(2);
    expect(recs.map((r) => r.seq)).toEqual([3, 4]);
    // …but the session ledger still counts every turn, buffered or evicted.
    expect(s.sessions()[0]!.turns).toBe(4);
  });
});

describe("SSE", () => {
  test("replays the buffer on connect, then streams what arrives next", async () => {
    const s = serve();
    await post(s.port, payload({ prompt: "first turn" }));

    const res = await fetch(`http://${DEFAULT_BIND}:${s.port}/events`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const frames: ObserveRecord[] = [];
    async function pump(until: number): Promise<void> {
      while (frames.length < until) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (chunk.startsWith("data: ")) frames.push(JSON.parse(chunk.slice(6)));
        }
      }
    }
    await pump(1);
    expect(frames[0]!.prompt).toBe("first turn"); // replayed

    await post(s.port, payload({ prompt: "second turn" }));
    await pump(2);
    expect(frames[1]!.prompt).toBe("second turn"); // streamed live
    expect(frames[1]!.session_totals.turns).toBe(2);
    await reader.cancel();
  });
});

describe("the page", () => {
  test("renders both the prompt and the system prompt sections for a PR-7 shaped payload", async () => {
    const s = serve();
    const system = "standing conventions block";
    const res = await post(s.port, payload({ prompt: "the whole prompt", system_prompt: system }));
    expect(res.status).toBe(200);
    const rec = s.records()[0]!;
    expect(rec.prompt).toBe("the whole prompt");
    expect(rec.system_prompt).toBe(system);
    expect(rec.sizes.prompt_tokens).toBe(estimateTokens("the whole prompt"));
    expect(rec.sizes.system_prompt_bytes).toBe(byteLength(system));
    expect(rec.sizes.turn_tokens).toBe(rec.sizes.prompt_tokens + rec.sizes.system_prompt_tokens);
    // Both sections exist in the page's renderer, and the identity block reads the pre-existing fields.
    const page = renderPage({ buffer: 10 });
    expect(page).toContain("prompt (the full text the harness built)");
    expect(page).toContain("system prompt (standing context, counted once per session)");
    expect(page).toContain("buzz identity");
    expect(page).toContain("what the relay event was");
    expect(page).toContain("what the agent would see");
  });

  test("is self-contained: no external script, stylesheet, font or off-loopback fetch", async () => {
    const s = serve();
    const html = await (await fetch(`http://${DEFAULT_BIND}:${s.port}/`)).text();
    expect(html).toContain("<!doctype html>");
    expect(html).not.toContain("<script src");
    expect(html).not.toContain("<link ");
    expect(html).not.toContain("@import");
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/\bsrc\s*=\s*["']\/\//);
    // The only network the page opens is this server's own SSE stream, by relative path.
    expect(html).toContain("new EventSource('/events')");
    expect(html).not.toContain("XMLHttpRequest");
    expect(html).not.toContain("WebSocket");
    expect(html.match(/fetch\(/g)).toBeNull();
  });

  test("the buffer size is inlined, not fetched", () => {
    const page = renderPage({ buffer: 42 });
    expect(page).toContain('"buffer":42');
  });

  test("nothing in the page builds DOM from a string, so a crafted payload cannot inject markup", async () => {
    const page = renderPage({ buffer: 10 });
    for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function"]) {
      expect(page).not.toContain(sink);
    }
    // The one inlined JSON literal cannot close the script element.
    expect(renderPage({ buffer: 10 })).not.toMatch(/<\/script>\s*var BOOT/);

    // A hostile delivery round-trips as data, verbatim, in every free-text field.
    const xss = `</script><img src=x onerror=alert(1)><script>`;
    const s = serve();
    const res = await post(
      s.port,
      payload({
        prompt: xss,
        system_prompt: xss,
        text: xss,
        relay: xss,
        session: { id: xss, cwd: xss, title: xss },
        tags: [["h", xss]],
      }),
    );
    expect(res.status).toBe(200);
    const rec = s.records()[0]!;
    expect(rec.prompt).toBe(xss);
    expect(rec.system_prompt).toBe(xss);
    expect(rec.session_title).toBe(xss);
    // /records is served as JSON, never sniffed as HTML.
    const json = await fetch(`http://${DEFAULT_BIND}:${s.port}/records`);
    expect(json.headers.get("content-type")).toContain("application/json");
    // The SSE frame stays one frame: JSON.stringify escapes the newlines that delimit it.
    expect(JSON.stringify(rec)).not.toContain("\n");
  });
});

describe("bind", () => {
  test("loopback is recognised; a routable address is not", () => {
    for (const h of ["127.0.0.1", "127.1.2.3", "localhost", "::1", "[::1]", "LOCALHOST"]) {
      expect(isLoopbackHost(h)).toBe(true);
    }
    for (const h of ["0.0.0.0", "::", "192.168.1.8", "10.0.0.5", "example.com"]) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });

  test("binding off loopback logs a warning; the default does not", () => {
    const lines: string[] = [];
    configureLog({ writer: (l: string) => lines.push(l), level: "debug" });
    try {
      startObserveServer({ host: DEFAULT_BIND, port: 0 }).stop();
      expect(lines.join("\n")).not.toContain("NON-LOOPBACK");
      lines.length = 0;
      startObserveServer({ host: "0.0.0.0", port: 0 }).stop();
      expect(lines.join("\n")).toContain("NON-LOOPBACK");
    } finally {
      configureLog({ writer: () => {} });
    }
  });
});
