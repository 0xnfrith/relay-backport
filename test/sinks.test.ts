import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rootIdOf, threadRoot, type Delivery, type EventLike } from "../src/delivery";
import { configureLog, redact, clearSecrets } from "../src/log";
import { ExecSink, HOOK_ENV_PASSTHROUGH, hookEnv } from "../src/sinks/exec";
import { FileSink, appendLine, formatLifecycleLine } from "../src/sinks/file";
import { WebhookSink, backoffMs, isRetryableStatus } from "../src/sinks/webhook";
import { CHANNEL, SENDER } from "./helpers/acp-client";
import { tmpDir } from "./helpers/tmp";

configureLog({ writer: () => {} });

let seq = 0;
function delivery(content = "hello", over: Partial<EventLike> = {}): Delivery {
  const event: EventLike = { id: String(++seq).padStart(64, "0"), kind: 9, pubkey: SENDER, content, tags: [["h", CHANNEL], ["p", "c".repeat(64)]], created_at: 1, ...over };
  return {
    event,
    channel: CHANNEL,
    threadRoot: threadRoot(event),
    rootId: rootIdOf(event),
    source: "text",
    session: { id: "sess-1", cwd: "/tmp" },
    prompt: "prompt text",
    relay: "wss://relay.example",
    receivedAt: 2,
  };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

describe("file sink", () => {
  test("appends MENTION| lines and EVENT| lifecycle lines, creates the directory, mode 0600", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const path = join(t.dir, "nested", "deliveries.jsonl");
    const sink = new FileSink(path);
    sink.lifecycle({ type: "session-new", sessionId: "s1" });
    const d = delivery("first");
    expect(await sink.deliver(d)).toBe(true);
    expect(await sink.deliver(delivery("second"))).toBe(true);
    sink.lifecycle({ type: "session-cancel", sessionId: "s1" });
    sink.lifecycle({ type: "closed" });
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    expect(lines[0]).toBe("EVENT|session|new|s1");
    expect(lines[1]).toBe(`MENTION|${JSON.stringify({ kind: 9, from: SENDER.slice(0, 8), h: CHANNEL, content: "first", id: d.event.id, tags: d.event.tags })}`);
    expect(lines[2]).toStartWith("MENTION|");
    expect(lines[3]).toBe("EVENT|session|cancel|s1");
    expect(lines[4]).toBe("EVENT|acp|closed");
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(formatLifecycleLine({ type: "closed" })).toBe("EVENT|acp|closed");
  });

  test("a deleted file is recreated on the next append; an unwritable path is a failed delivery, not a crash", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const path = join(t.dir, "d.jsonl");
    appendLine(path, "one");
    const { unlinkSync } = await import("node:fs");
    unlinkSync(path);
    expect(await new FileSink(path).deliver(delivery())).toBe(true);
    expect(existsSync(path)).toBe(true);
    const blocked = join(t.dir, "file-not-dir");
    writeFileSync(blocked, "x");
    expect(await new FileSink(join(blocked, "d.jsonl")).deliver(delivery())).toBe(false);
  });
});

describe("webhook sink", () => {
  test("posts the payload with a bearer from a file; the bearer is redacted in logs", async () => {
    clearSecrets();
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const bearerPath = join(t.dir, "bearer");
    writeFileSync(bearerPath, "super-secret-token-value\n");
    const got: { auth: string | null; body: Record<string, unknown> }[] = [];
    const srv = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        got.push({ auth: req.headers.get("authorization"), body: (await req.json()) as Record<string, unknown> });
        return new Response("ok");
      },
    });
    cleanups.push(() => srv.stop(true));
    const sink = new WebhookSink({ url: `http://127.0.0.1:${srv.port}/h`, bearerFile: bearerPath, timeoutMs: 2000, attempts: 1 });
    const d = delivery("x");
    expect(await sink.deliver(d)).toBe(true);
    expect(got[0]?.auth).toBe("Bearer super-secret-token-value");
    expect(got[0]?.body).toMatchObject({ source: "buzz", transport: "acp", event_id: d.event.id, text: "x", prompt: "prompt text", session: { id: "sess-1" } });
    expect(redact("token super-secret-token-value here")).toBe("token [redacted] here");
    expect(() => new WebhookSink({ url: "http://x", bearerFile: "/nope/bearer", timeoutMs: 1, attempts: 1 })).toThrow(/bearer/);
  });

  test("retries 5xx with backoff and gives up after attempts; 4xx is final; network errors retry", async () => {
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
    const sink = new WebhookSink({ url: `http://127.0.0.1:${srv.port}/h`, timeoutMs: 2000, attempts: 3 }, undefined, { sleep: async (ms) => void sleeps.push(ms) });
    expect(await sink.deliver(delivery())).toBe(false);
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
    expect(await new WebhookSink({ url: `http://127.0.0.1:${srv4.port}/h`, timeoutMs: 2000, attempts: 3 }, undefined, { sleep: async () => {} }).deliver(delivery())).toBe(false);
    expect(calls4).toBe(1);

    const down: number[] = [];
    expect(await new WebhookSink({ url: "http://127.0.0.1:1/h", timeoutMs: 1000, attempts: 2 }, undefined, { sleep: async (ms) => void down.push(ms) }).deliver(delivery())).toBe(false);
    expect(down.length).toBe(1);
    expect(isRetryableStatus(429)).toBe(true);
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
      `const ev = JSON.parse(await Bun.stdin.text());\nawait Bun.write(${JSON.stringify(out)}, (await Bun.file(${JSON.stringify(out)}).text().catch(() => "")) + ev.event_id + " " + process.env.RELAY_BACKPORT_CHANNEL + " " + process.env.RELAY_BACKPORT_SESSION_ID + " " + ev.prompt + "\\n");\n`,
    );
    const sink = new ExecSink({ command: [process.execPath, script], timeoutMs: 10_000, passBuzzEnv: false }, {});
    const a = delivery("a");
    const b = delivery("b");
    const [ra, rb] = await Promise.all([sink.deliver(a), sink.deliver(b)]);
    expect(ra).toBe(true);
    expect(rb).toBe(true);
    expect((await Bun.file(out).text()).trim().split("\n")).toEqual([`${a.event.id} ${CHANNEL} sess-1 prompt text`, `${b.event.id} ${CHANNEL} sess-1 prompt text`]);
  });

  test("the hook sees a minimal environment; BUZZ_* crosses only with pass_buzz_env", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const out = join(t.dir, "env.json");
    const script = join(t.dir, "dump-env.ts");
    writeFileSync(script, `await Bun.write(${JSON.stringify(out)}, JSON.stringify(process.env));\n`);
    const harnessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LC_ALL: "C",
      BUZZ_PRIVATE_KEY: "nsec1-should-not-reach-the-hook-by-default",
      BUZZ_RELAY_URL: "wss://relay.example",
      BUZZ_AUTH_TAG: "auth-tag",
      NOSTR_PRIVATE_KEY: "nsec1-legacy",
      RELAY_BACKPORT_WEBHOOK_BEARER_FILE: "/secret/path",
      SOMETHING_ELSE: "no",
    };
    const d = delivery("env");
    expect(await new ExecSink({ command: [process.execPath, script], timeoutMs: 10_000, passBuzzEnv: false }, harnessEnv).deliver(d)).toBe(true);
    const seen = JSON.parse(await Bun.file(out).text()) as Record<string, string>;
    expect(seen.BUZZ_PRIVATE_KEY).toBeUndefined();
    expect(seen.BUZZ_RELAY_URL).toBeUndefined();
    expect(seen.RELAY_BACKPORT_WEBHOOK_BEARER_FILE).toBeUndefined();
    expect(seen.SOMETHING_ELSE).toBeUndefined();
    expect(seen.PATH).toBe(process.env.PATH);
    expect(seen.LC_ALL).toBe("C");
    expect(seen.RELAY_BACKPORT_EVENT_ID).toBe(d.event.id);
    expect(seen.RELAY_BACKPORT_AUTHOR).toBe(SENDER);
    for (const k of Object.keys(seen)) expect(HOOK_ENV_PASSTHROUGH.includes(k) || k.startsWith("LC_") || k.startsWith("RELAY_BACKPORT_")).toBe(true);

    expect(await new ExecSink({ command: [process.execPath, script], timeoutMs: 10_000, passBuzzEnv: true }, harnessEnv).deliver(d)).toBe(true);
    const withBuzz = JSON.parse(await Bun.file(out).text()) as Record<string, string>;
    expect(withBuzz.BUZZ_PRIVATE_KEY).toBe("nsec1-should-not-reach-the-hook-by-default");
    expect(withBuzz.BUZZ_RELAY_URL).toBe("wss://relay.example");
    expect(withBuzz.BUZZ_AUTH_TAG).toBe("auth-tag");
    expect(withBuzz.NOSTR_PRIVATE_KEY).toBe("nsec1-legacy");
    expect(withBuzz.SOMETHING_ELSE).toBeUndefined();
    expect(Object.keys(hookEnv(d, harnessEnv, true)).sort()).toEqual(
      ["BUZZ_AUTH_TAG", "BUZZ_PRIVATE_KEY", "BUZZ_RELAY_URL", "HOME", "LC_ALL", "NOSTR_PRIVATE_KEY", "PATH", "RELAY_BACKPORT_AUTHOR", "RELAY_BACKPORT_CHANNEL", "RELAY_BACKPORT_EVENT_ID", "RELAY_BACKPORT_KIND", "RELAY_BACKPORT_RELAY", "RELAY_BACKPORT_SESSION_ID"].sort(),
    );
  });

  test("the hook's stdout never reaches our stdout; non-zero exit, timeout and a missing binary are failures", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const chatty = join(t.dir, "chatty.ts");
    writeFileSync(chatty, 'console.log("this must not appear on relay-backport stdout");\n');
    const fail = join(t.dir, "fail.ts");
    writeFileSync(fail, "process.exit(3);\n");
    const slow = join(t.dir, "slow.ts");
    writeFileSync(slow, "await Bun.sleep(5000);\n");
    const runner = join(t.dir, "runner.ts");
    writeFileSync(
      runner,
      `import { ExecSink } from ${JSON.stringify(join(import.meta.dir, "..", "src", "sinks", "exec.ts"))};\nimport { configureLog } from ${JSON.stringify(join(import.meta.dir, "..", "src", "log.ts"))};\nconfigureLog({ writer: () => {} });\nconst sink = new ExecSink({ command: [process.execPath, ${JSON.stringify(chatty)}], timeoutMs: 10_000, passBuzzEnv: false }, process.env);\nconst ok = await sink.deliver({ event: { id: "a".repeat(64), kind: 9, pubkey: "", content: "", tags: [], created_at: 0 }, channel: "", threadRoot: "", source: "synthetic", session: { id: "s", cwd: "" }, prompt: "", relay: "", receivedAt: 0 });\nconsole.log("RESULT " + ok);\n`,
    );
    const proc = Bun.spawn([process.execPath, runner], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(stdout.trim()).toBe("RESULT true");
    expect(stderr).toContain("this must not appear on relay-backport stdout");

    expect(await new ExecSink({ command: [process.execPath, fail], timeoutMs: 10_000, passBuzzEnv: false }, {}).deliver(delivery())).toBe(false);
    expect(await new ExecSink({ command: [process.execPath, slow], timeoutMs: 300, passBuzzEnv: false }, {}).deliver(delivery())).toBe(false);
    expect(await new ExecSink({ command: ["/definitely/not/a/binary"], timeoutMs: 300, passBuzzEnv: false }, {}).deliver(delivery())).toBe(false);
  });
});
