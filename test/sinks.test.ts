import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { configureLog, redact, clearSecrets } from "../src/log";
import type { MentionRecord } from "../src/mention";
import { AcpSink } from "../src/sinks/acp";
import { ExecSink } from "../src/sinks/exec";
import { StdoutSink } from "../src/sinks/stdout";
import { WebhookSink, backoffMs, buildWebhookPayload, isRetryableStatus } from "../src/sinks/webhook";
import { CHANNEL_A, channelMessage, keypair } from "./helpers/mock-relay";
import { tmpDir } from "./helpers/tmp";

configureLog({ writer: () => {} });

const owner = keypair();
const self = keypair();

function record(content = "hello", kind = 9): MentionRecord {
  const event = channelMessage(owner.sk, CHANNEL_A, content, [["p", self.pk]], kind);
  return {
    event,
    relay: "wss://relay.example",
    channel: CHANNEL_A,
    threadRoot: event.id,
    ptag: true,
    text: false,
    fromOwner: true,
    allowedBy: "owner",
    receivedAt: event.created_at,
  };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

describe("stdout sink", () => {
  test("prints MENTION| lines and EVENT| lifecycle lines", async () => {
    const lines: string[] = [];
    const sink = new StdoutSink((l) => lines.push(l));
    const r = record("hi");
    expect(await sink.deliver(r)).toBe(true);
    sink.lifecycle({ type: "closed", code: 1006, reason: "" });
    sink.lifecycle({ type: "auth-failed", message: "nope" });
    expect(lines[0]).toBe(`MENTION|${JSON.stringify({ kind: 9, from: owner.pk.slice(0, 8), h: CHANNEL_A, content: "hi", id: r.event.id, tags: r.event.tags })}`);
    expect(lines[1]).toBe("EVENT|closed|1006");
    expect(lines[2]).toBe("EVENT|auth-failed|nope");
  });
});

describe("webhook sink", () => {
  test("payload shape is a superset of the classic bridge payload", () => {
    const p = buildWebhookPayload(record("t"));
    expect(p.source).toBe("buzz");
    expect(p.channel).toBe(CHANNEL_A);
    expect(p.event_id).toBe(p.reply_to);
    expect(p.thread_root).toBe(p.event_id);
    expect(p.text).toBe("t");
    expect(p.mention).toEqual({ ptag: true, text: false, from_owner: true, allowed_by: "owner" });
  });

  test("posts JSON with bearer from a file; bearer is redacted in logs", async () => {
    clearSecrets();
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const bearerPath = join(t.dir, "bearer");
    writeFileSync(bearerPath, "super-secret-token-value\n");
    const got: { auth: string | null; body: unknown }[] = [];
    const srv = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        got.push({ auth: req.headers.get("authorization"), body: await req.json() });
        return new Response("ok");
      },
    });
    cleanups.push(() => srv.stop(true));
    const sink = new WebhookSink({ url: `http://127.0.0.1:${srv.port}/h`, bearerFile: bearerPath, timeoutMs: 2000, attempts: 1 });
    const r = record("x");
    expect(await sink.deliver(r)).toBe(true);
    expect(got[0]?.auth).toBe("Bearer super-secret-token-value");
    expect((got[0]?.body as { event_id: string }).event_id).toBe(r.event.id);
    expect(redact("token super-secret-token-value here")).toBe("token [redacted] here");
  });

  test("retries 5xx with backoff, gives up after attempts; 4xx is final", async () => {
    let calls = 0;
    const srv = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        calls++;
        return new Response("boom", { status: 503 });
      },
    });
    cleanups.push(() => srv.stop(true));
    const sleeps: number[] = [];
    const sink = new WebhookSink(
      { url: `http://127.0.0.1:${srv.port}/h`, timeoutMs: 2000, attempts: 3 },
      undefined,
      { sleep: async (ms) => void sleeps.push(ms) },
    );
    expect(await sink.deliver(record())).toBe(false);
    expect(calls).toBe(3);
    expect(sleeps).toEqual([1000, 2000]);

    let calls4 = 0;
    const srv4 = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        calls4++;
        return new Response("no", { status: 400 });
      },
    });
    cleanups.push(() => srv4.stop(true));
    const sink4 = new WebhookSink({ url: `http://127.0.0.1:${srv4.port}/h`, timeoutMs: 2000, attempts: 3 }, undefined, {
      sleep: async () => {},
    });
    expect(await sink4.deliver(record())).toBe(false);
    expect(calls4).toBe(1);
  });

  test("network error is retried; helpers", async () => {
    const sleeps: number[] = [];
    const sink = new WebhookSink({ url: "http://127.0.0.1:1/h", timeoutMs: 1000, attempts: 2 }, undefined, {
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect(await sink.deliver(record())).toBe(false);
    expect(sleeps.length).toBe(1);
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(404)).toBe(false);
    expect(backoffMs(5)).toBe(10_000);
  });
});

describe("exec sink", () => {
  test("runs the command with the payload on stdin, exit 0 = delivered, serial order", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const out = join(t.dir, "out.jsonl");
    const script = join(t.dir, "handler.ts");
    writeFileSync(
      script,
      `const text = await Bun.stdin.text();\nconst ev = JSON.parse(text);\nawait Bun.write("${out.replaceAll("\\", "\\\\")}", (await Bun.file("${out.replaceAll("\\", "\\\\")}").text().catch(() => "")) + ev.event_id + " " + process.env.RELAY_BACKPORT_CHANNEL + "\\n");\n`,
    );
    const sink = new ExecSink({ command: [process.execPath, script], timeoutMs: 10_000 });
    const a = record("a");
    const b = record("b");
    const [ra, rb] = await Promise.all([sink.deliver(a), sink.deliver(b)]);
    expect(ra).toBe(true);
    expect(rb).toBe(true);
    const lines = (await Bun.file(out).text()).trim().split("\n");
    expect(lines).toEqual([`${a.event.id} ${CHANNEL_A}`, `${b.event.id} ${CHANNEL_A}`]);
  });

  test("non-zero exit and timeout are failures", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const fail = join(t.dir, "fail.ts");
    writeFileSync(fail, "process.exit(3);\n");
    const slow = join(t.dir, "slow.ts");
    writeFileSync(slow, "await Bun.sleep(5000);\n");
    expect(await new ExecSink({ command: [process.execPath, fail], timeoutMs: 10_000 }).deliver(record())).toBe(false);
    expect(await new ExecSink({ command: [process.execPath, slow], timeoutMs: 300 }).deliver(record())).toBe(false);
    expect(await new ExecSink({ command: ["/definitely/not/a/binary"], timeoutMs: 300 }).deliver(record())).toBe(false);
  });
});

describe("acp sink (scaffold)", () => {
  test("rejects every delivery so the mention is not marked delivered", async () => {
    const sink = new AcpSink({ command: ["some-agent", "acp"] });
    expect(sink.name).toBe("acp");
    expect(await sink.deliver(record())).toBe(false);
    expect(await sink.deliver(record())).toBe(false);
  });
});
