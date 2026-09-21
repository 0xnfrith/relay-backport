import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rootIdOf, threadRoot, type Delivery, type EventLike } from "../src/delivery";
import { configureLog, redact, clearSecrets } from "../src/log";
import { ExecSink, HOOK_ENV_PASSTHROUGH, hookEnv } from "../src/sinks/exec";
import { FileSink, appendLine, formatLifecycleLine } from "../src/sinks/file";
import { WebhookSink, backoffMs, isRetryableStatus } from "../src/sinks/webhook";
import { tailFile } from "../src/tail";
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
    systemPrompt: "",
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
    const sink = new FileSink({ path });
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
    expect(await new FileSink({ path }).deliver(delivery())).toBe(true);
    expect(existsSync(path)).toBe(true);
    const blocked = join(t.dir, "file-not-dir");
    writeFileSync(blocked, "x");
    expect(await new FileSink({ path: join(blocked, "d.jsonl") }).deliver(delivery())).toBe(false);
  });

  test("file.content_max_chars: uncapped by default, caps and flags when set, and tail parses both lines", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const path = join(t.dir, "deliveries.jsonl");
    const long = "y".repeat(2000);
    expect(await new FileSink({ path }).deliver(delivery(long))).toBe(true);
    expect(await new FileSink({ path, contentMaxChars: 100 }).deliver(delivery(long))).toBe(true);

    const printed: string[] = [];
    await tailFile({ path, write: (l) => printed.push(l), follow: false, lines: 10 });
    expect(printed.length).toBe(2);

    const whole = JSON.parse(printed[0]!.slice("MENTION|".length));
    expect(whole.content).toBe(long);
    expect(whole.truncated).toBeUndefined();

    const capped = JSON.parse(printed[1]!.slice("MENTION|".length));
    expect(capped.content).toBe("y".repeat(100));
    expect(capped.truncated).toBe(true);
  });

  test("file.prompt_fields is off by default; when on, header words are appended after existing keys", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const path = join(t.dir, "deliveries.jsonl");
    const d = delivery("hello");
    d.promptFields = { channelName: "general", scope: "channel", senderName: "Alice", replyTo: d.event.id };
    expect(await new FileSink({ path }).deliver(d)).toBe(true);
    expect(await new FileSink({ path, promptFields: true }).deliver(d)).toBe(true);
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    const off = JSON.parse(lines[0]!.slice("MENTION|".length));
    expect(off.channel_name).toBeUndefined();
    expect(Object.keys(off)).toEqual(["kind", "from", "h", "content", "id", "tags"]);
    const on = JSON.parse(lines[1]!.slice("MENTION|".length));
    expect(on.channel_name).toBe("general");
    expect(on.scope).toBe("channel");
    expect(on.sender_name).toBe("Alice");
    expect(on.reply_to).toBe(d.event.id);
    expect(on.created_at).toBe(1);
  });

  test("a system prompt (or buzz env file) write that fails does not suppress the EVENT|session|new| lifecycle line", () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const path = join(t.dir, "deliveries.jsonl");
    // stateDir points at a file, not a directory: mkdirSync for sessions/ fails
    const blockedStateDir = join(t.dir, "not-a-dir");
    writeFileSync(blockedStateDir, "x");
    const sink = new FileSink({ path, stateDir: blockedStateDir, buzzEnvFile: join(blockedStateDir, "buzz.env") });
    sink.lifecycle({ type: "session-new", sessionId: "sess-f", systemPrompt: "be terse" });
    // both side-effect writes failed, but the lifecycle line still landed, with no path suffix
    expect(readFileSync(path, "utf8").trimEnd().split("\n")).toEqual(["EVENT|session|new|sess-f"]);
  });

  test("a session-new lifecycle with a system prompt writes it to <state_dir>/sessions/<id>.system-prompt.md, 0600, and the EVENT line carries the path", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const path = join(t.dir, "deliveries.jsonl");
    const sink = new FileSink({ path, stateDir: t.dir });
    sink.lifecycle({ type: "session-new", sessionId: "sess-a", systemPrompt: "be terse\nnever compress" });
    const expected = join(t.dir, "sessions", "sess-a.system-prompt.md");
    expect(readFileSync(expected, "utf8")).toBe("be terse\nnever compress");
    if (process.platform !== "win32") expect(statSync(expected).mode & 0o777).toBe(0o600);
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    expect(lines[0]).toBe(`EVENT|session|new|sess-a|${expected}`);
  });

  test("file.system_prompt = false writes nothing to disk and leaves the EVENT line unchanged", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const path = join(t.dir, "deliveries.jsonl");
    const sink = new FileSink({ path, stateDir: t.dir, systemPrompt: false });
    sink.lifecycle({ type: "session-new", sessionId: "sess-b", systemPrompt: "do not persist me" });
    expect(existsSync(join(t.dir, "sessions"))).toBe(false);
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    expect(lines[0]).toBe("EVENT|session|new|sess-b");
  });

  test("an empty system prompt writes nothing, same as no system prompt at all", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const path = join(t.dir, "deliveries.jsonl");
    const sink = new FileSink({ path, stateDir: t.dir });
    sink.lifecycle({ type: "session-new", sessionId: "sess-c", systemPrompt: "" });
    expect(existsSync(join(t.dir, "sessions"))).toBe(false);
    expect(readFileSync(path, "utf8").trimEnd().split("\n")[0]).toBe("EVENT|session|new|sess-c");
  });

  test("file.buzz_env_file: writes exactly the present BUZZ_* vars as KEY=value, 0600, on every session-new; log names only the path and count", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const path = join(t.dir, "deliveries.jsonl");
    const envFile = join(t.dir, "buzz.env");
    const seen: string[] = [];
    configureLog({ writer: (l) => seen.push(l) });
    const sink = new FileSink({
      path,
      stateDir: t.dir,
      systemPrompt: false,
      buzzEnvFile: envFile,
      env: { BUZZ_RELAY_URL: "wss://relay.example", BUZZ_PRIVATE_KEY: "nsec1supersecretvalue", NOSTR_PRIVATE_KEY: "unrelated" },
    });
    sink.lifecycle({ type: "session-new", sessionId: "sess-d" });
    const written = readFileSync(envFile, "utf8");
    expect(written).toBe("BUZZ_RELAY_URL=wss://relay.example\nBUZZ_PRIVATE_KEY=nsec1supersecretvalue\n");
    if (process.platform !== "win32") expect(statSync(envFile).mode & 0o777).toBe(0o600);
    const joined = seen.join("\n");
    expect(joined).toContain(`wrote buzz env file ${envFile} (2 vars)`);
    expect(joined).not.toContain("nsec1supersecretvalue");
    configureLog({ writer: () => {} });
  });

  test("file.buzz_env_file with none of the vars present writes an empty file", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const path = join(t.dir, "deliveries.jsonl");
    const envFile = join(t.dir, "buzz.env");
    const sink = new FileSink({ path, stateDir: t.dir, buzzEnvFile: envFile, env: {} });
    sink.lifecycle({ type: "session-new", sessionId: "sess-e" });
    expect(readFileSync(envFile, "utf8")).toBe("");
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
    const sink = new WebhookSink({ url: `http://127.0.0.1:${srv.port}/h`, bearerFile: bearerPath, timeoutMs: 2000, attempts: 1, includeSystemPrompt: true, threadContext: "delta" as const, cumulativeMaxChars: 32_000 });
    const d = delivery("x");
    expect(await sink.deliver(d)).toBe(true);
    expect(got[0]?.auth).toBe("Bearer super-secret-token-value");
    expect(got[0]?.body).toMatchObject({ source: "buzz", transport: "acp", event_id: d.event.id, text: "x", prompt: "prompt text", session: { id: "sess-1" } });
    expect(redact("token super-secret-token-value here")).toBe("token [redacted] here");
    expect(() => new WebhookSink({ url: "http://x", bearerFile: "/nope/bearer", timeoutMs: 1, attempts: 1, includeSystemPrompt: false, threadContext: "delta" as const, cumulativeMaxChars: 32_000 })).toThrow(/bearer/);
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
    const sink = new WebhookSink({ url: `http://127.0.0.1:${srv.port}/h`, timeoutMs: 2000, attempts: 3, includeSystemPrompt: false, threadContext: "delta" as const, cumulativeMaxChars: 32_000 }, undefined, { sleep: async (ms) => void sleeps.push(ms) });
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
    expect(await new WebhookSink({ url: `http://127.0.0.1:${srv4.port}/h`, timeoutMs: 2000, attempts: 3, includeSystemPrompt: false, threadContext: "delta" as const, cumulativeMaxChars: 32_000 }, undefined, { sleep: async () => {} }).deliver(delivery())).toBe(false);
    expect(calls4).toBe(1);

    const down: number[] = [];
    expect(await new WebhookSink({ url: "http://127.0.0.1:1/h", timeoutMs: 1000, attempts: 2, includeSystemPrompt: false, threadContext: "delta" as const, cumulativeMaxChars: 32_000 }, undefined, { sleep: async (ms) => void down.push(ms) }).deliver(delivery())).toBe(false);
    expect(down.length).toBe(1);
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(404)).toBe(false);
    expect(backoffMs(5)).toBe(10_000);
  });

  test("include_system_prompt: on by default in practice — the sink adds system_prompt only when told to and the session had one", async () => {
    const got: Record<string, unknown>[] = [];
    const srv = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        got.push((await req.json()) as Record<string, unknown>);
        return new Response("ok");
      },
    });
    cleanups.push(() => srv.stop(true));
    const withPrompt = { ...delivery("x"), systemPrompt: "be terse\nnever compress" };

    const on = new WebhookSink({ url: `http://127.0.0.1:${srv.port}/h`, timeoutMs: 2000, attempts: 1, includeSystemPrompt: true , threadContext: "delta" as const, cumulativeMaxChars: 32_000 });
    expect(await on.deliver(withPrompt)).toBe(true);
    expect(got[0]?.system_prompt).toBe("be terse\nnever compress");

    const off = new WebhookSink({ url: `http://127.0.0.1:${srv.port}/h`, timeoutMs: 2000, attempts: 1, includeSystemPrompt: false , threadContext: "delta" as const, cumulativeMaxChars: 32_000 });
    expect(await off.deliver(withPrompt)).toBe(true);
    expect("system_prompt" in got[1]!).toBe(false);
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
    const sink = new ExecSink({ command: [process.execPath, script], timeoutMs: 10_000, passBuzzEnv: false, includeSystemPrompt: false }, {});
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
    expect(await new ExecSink({ command: [process.execPath, script], timeoutMs: 10_000, passBuzzEnv: false, includeSystemPrompt: false }, harnessEnv).deliver(d)).toBe(true);
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

    expect(await new ExecSink({ command: [process.execPath, script], timeoutMs: 10_000, passBuzzEnv: true, includeSystemPrompt: false }, harnessEnv).deliver(d)).toBe(true);
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

    expect(await new ExecSink({ command: [process.execPath, fail], timeoutMs: 10_000, passBuzzEnv: false, includeSystemPrompt: false }, {}).deliver(delivery())).toBe(false);
    expect(await new ExecSink({ command: [process.execPath, slow], timeoutMs: 300, passBuzzEnv: false, includeSystemPrompt: false }, {}).deliver(delivery())).toBe(false);
    expect(await new ExecSink({ command: ["/definitely/not/a/binary"], timeoutMs: 300, passBuzzEnv: false, includeSystemPrompt: false }, {}).deliver(delivery())).toBe(false);
  });

  test("include_system_prompt: false by default, true adds system_prompt to stdin only when the session had one", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const out = join(t.dir, "out.json");
    const script = join(t.dir, "capture.ts");
    writeFileSync(script, `await Bun.write(${JSON.stringify(out)}, await Bun.stdin.text());\n`);
    const withPrompt = { ...delivery("x"), systemPrompt: "be terse" };

    expect(await new ExecSink({ command: [process.execPath, script], timeoutMs: 10_000, passBuzzEnv: false, includeSystemPrompt: false }, {}).deliver(withPrompt)).toBe(true);
    expect("system_prompt" in JSON.parse(await Bun.file(out).text())).toBe(false);

    expect(await new ExecSink({ command: [process.execPath, script], timeoutMs: 10_000, passBuzzEnv: false, includeSystemPrompt: true }, {}).deliver(withPrompt)).toBe(true);
    expect(JSON.parse(await Bun.file(out).text()).system_prompt).toBe("be terse");
  });
});

describe("file sink thread context", () => {
  /** One delivery in a named session, with a prompt that may carry a `<thread-context>` block. */
  function turn(sessionId: string, content: string, block?: string): Delivery {
    const d = delivery(content);
    return {
      ...d,
      session: { id: sessionId, cwd: "/tmp" },
      prompt: block ? `<thread-context>\n${block}\n</thread-context>\n${content}` : content,
    };
  }

  /** The parsed MENTION lines a run produced, in order. */
  function mentions(path: string): Record<string, unknown>[] {
    return readFileSync(path, "utf8")
      .trimEnd()
      .split("\n")
      .filter((l) => l.startsWith("MENTION|"))
      .map((l) => JSON.parse(l.slice("MENTION|".length)) as Record<string, unknown>);
  }

  type Entry = { kind: string; event_id: string; at: number; text: string; truncated?: true };
  const entries = (m: Record<string, unknown>): Entry[] => (m.thread_context as Entry[] | undefined) ?? [];

  test('"none" leaves the line exactly as 0.3.2 wrote it', async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const path = join(t.dir, "d.jsonl");
    const sink = new FileSink({ path, stateDir: t.dir, threadContext: "none" });
    const a = turn("none-1", "first", "history A");
    await sink.deliver(a);
    await sink.deliver(turn("none-1", "second", "history B"));
    const lines = mentions(path);
    expect(lines.every((m) => !("thread_context" in m) && !("thread_truncated" in m))).toBe(true);
    expect(readFileSync(path, "utf8").split("\n")[0]).toBe(
      `MENTION|${JSON.stringify({ kind: 9, from: SENDER.slice(0, 8), h: CHANNEL, content: "first", id: a.event.id, tags: a.event.tags })}`,
    );
    expect(existsSync(join(t.dir, "sessions"))).toBe(false);
  });

  test('"cumulative" carries every block and every mention delivered before this one — never this turn\'s own', async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const path = join(t.dir, "d.jsonl");
    const sink = new FileSink({ path, stateDir: t.dir });
    const a = turn("cum-1", "remember HARBOR", "history A");
    const b = turn("cum-1", "what word?");
    const c = turn("cum-1", "and again?", "history C");
    await sink.deliver(a);
    await sink.deliver(b);
    await sink.deliver(c);
    const [m1, m2, m3] = mentions(path);

    expect(entries(m1!).map((e) => e.kind)).toEqual(["block"]);
    expect(entries(m1!)[0]!.text).toContain("history A");

    // turn 2: turn 1's block plus turn 1's mention; not turn 2's own text
    expect(entries(m2!).map((e) => e.kind)).toEqual(["block", "event"]);
    expect(entries(m2!)[1]!.text).toContain("remember HARBOR");
    expect(entries(m2!)[1]!.event_id).toBe(a.event.id);
    expect(entries(m2!).some((e) => e.event_id === b.event.id)).toBe(false);

    // turn 3: everything before it, in delivery order, plus its own block
    expect(entries(m3!).map((e) => e.kind)).toEqual(["block", "event", "event", "block"]);
    expect(entries(m3!).map((e) => e.event_id)).toEqual([a.event.id, a.event.id, b.event.id, c.event.id]);
    expect(m3!.thread_truncated).toBeUndefined();

    // its own ledger file, not the webhook's
    expect(existsSync(join(t.dir, "sessions", "cum-1.file-context.jsonl"))).toBe(true);
    expect(existsSync(join(t.dir, "sessions", "cum-1.context.jsonl"))).toBe(false);
  });

  test('"new" carries only what arrived since the previous MENTION line of that session', async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const path = join(t.dir, "d.jsonl");
    const sink = new FileSink({ path, stateDir: t.dir, threadContext: "new" });
    const a = turn("new-1", "one", "history A");
    const b = turn("new-1", "two");
    const c = turn("new-1", "three", "history C");
    await sink.deliver(a);
    await sink.deliver(b);
    await sink.deliver(c);
    const [m1, m2, m3] = mentions(path);
    expect(entries(m1!).map((e) => [e.kind, e.event_id])).toEqual([["block", a.event.id]]);
    // turn N = turn N's block (when the prompt had one) + turn N-1's mention
    expect(entries(m2!).map((e) => [e.kind, e.event_id])).toEqual([["event", a.event.id]]);
    expect(entries(m3!).map((e) => [e.kind, e.event_id])).toEqual([
      ["event", b.event.id],
      ["block", c.event.id],
    ]);
    // a second session keeps its own window
    const d2 = turn("new-2", "elsewhere", "history D");
    await sink.deliver(d2);
    expect(entries(mentions(path)[3]!).map((e) => e.event_id)).toEqual([d2.event.id]);
  });

  test("content_max_chars caps each entry's text and marks it truncated", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const path = join(t.dir, "d.jsonl");
    const sink = new FileSink({ path, stateDir: t.dir, contentMaxChars: 10 });
    await sink.deliver(turn("cap-1", "x".repeat(50), "y".repeat(50)));
    await sink.deliver(turn("cap-1", "short"));
    const [, m2] = mentions(path);
    const block = entries(m2!)[0]!;
    expect(block.text).toBe("y".repeat(10));
    expect(block.truncated).toBe(true);
    expect(entries(m2!)[1]!.text.length).toBe(10);
    expect(m2!.content).toBe("short"); // under the cap: no flag on the line itself
    expect(m2!.truncated).toBeUndefined();
  });

  test("thread_context_max_chars drops whole entries from the oldest end, and says so", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const path = join(t.dir, "d.jsonl");
    const sink = new FileSink({ path, stateDir: t.dir, threadContextMaxChars: 120 });
    const a = turn("bound-1", "one", "A".repeat(100));
    const b = turn("bound-1", "two", "B".repeat(100));
    const c = turn("bound-1", "three", "C".repeat(100));
    await sink.deliver(a);
    await sink.deliver(b);
    await sink.deliver(c);
    const m3 = mentions(path)[2]!;
    const texts = entries(m3!).map((e) => e.text);
    expect(m3.thread_truncated).toBe(true);
    expect(texts[texts.length - 1]).toBe("C".repeat(100)); // newest kept
    expect(texts.some((x) => x.startsWith("A".repeat(100)))).toBe(false); // oldest dropped
    expect(texts.join("").length).toBeLessThanOrEqual(120);

    // 0 means unlimited
    const un = new FileSink({ path: join(t.dir, "u.jsonl"), stateDir: join(t.dir, "u"), threadContextMaxChars: 0 });
    await un.deliver(turn("unbound-1", "one", "A".repeat(100_000)));
    await un.deliver(turn("unbound-1", "two"));
    const u2 = mentions(join(t.dir, "u.jsonl"))[1]!;
    expect(u2.thread_truncated).toBeUndefined();
    expect(entries(u2)[0]!.text.length).toBe(100_000);
  });

  test("a consumer that ignores unknown keys is unaffected: every pre-0.3.3 field keeps its place", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const path = join(t.dir, "d.jsonl");
    const sink = new FileSink({ path, stateDir: t.dir });
    await sink.deliver(turn("compat-1", "first", "history"));
    const second = turn("compat-1", "second");
    await sink.deliver(second);
    const m2 = mentions(path)[1]!;
    expect(Object.keys(m2).slice(0, 6)).toEqual(["kind", "from", "h", "content", "id", "tags"]);
    expect(Object.keys(m2).slice(6)).toEqual(["thread_context"]);
    expect(m2.content).toBe("second");
    expect(m2.id).toBe(second.event.id);
    // and the line still round-trips as one JSON object on one line
    expect(readFileSync(path, "utf8").trimEnd().split("\n")).toHaveLength(2);
  });

  test("the file and webhook ledgers are separate files, each with one line per (kind, event)", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const path = join(t.dir, "d.jsonl");
    const file = new FileSink({ path, stateDir: t.dir });
    const posted: unknown[] = [];
    const hook = new WebhookSink(
      { url: "http://127.0.0.1:1/h", timeoutMs: 100, attempts: 1, includeSystemPrompt: false, threadContext: "cumulative" as const, cumulativeMaxChars: 32_000 },
      () => "",
      {
        stateDir: t.dir,
        fetchImpl: (async (_u: string, init: { body: string }) => {
          posted.push(JSON.parse(init.body));
          return new Response("ok", { status: 200 });
        }) as unknown as typeof fetch,
      },
    );
    const a = turn("both-1", "one", "history A");
    const b = turn("both-1", "two");
    for (const d of [a, b]) {
      await file.deliver(d);
      await hook.deliver(d);
    }
    const count = (p: string) => readFileSync(p, "utf8").trimEnd().split("\n").length;
    expect(count(join(t.dir, "sessions", "both-1.file-context.jsonl"))).toBe(3); // block + 2 events
    expect(count(join(t.dir, "sessions", "both-1.context.jsonl"))).toBe(3);
    expect((posted[1] as { thread_context_cumulative: string }).thread_context_cumulative).toContain("one");
  });
});
