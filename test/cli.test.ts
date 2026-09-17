import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HELP, main, overridesFromFlags, parseArgs } from "../src/cli";
import { configureLog } from "../src/log";
import { waitFor } from "./helpers/acp-client";
import { tmpDir } from "./helpers/tmp";

configureLog({ writer: () => {} });

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function io(env: Record<string, string> = {}, extra: { stdin?: ReadableStream<Uint8Array>; signal?: AbortSignal } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return { out: (s: string) => out.push(s), err: (s: string) => err.push(s), env, outLines: out, errLines: err, ...extra };
}

describe("argument parsing", () => {
  test("commands, value flags, booleans, repeatable --sink, --key=value, -- terminator", () => {
    const a = parseArgs(["tail", "--file", "/x", "--lines=5", "--no-follow", "--sink", "file", "--sink=webhook", "--", "--not-a-flag"]);
    expect(a.command).toBe("tail");
    expect(a.positional).toEqual(["--not-a-flag"]);
    expect(a.flags).toEqual({ file: "/x", lines: "5", "no-follow": true, sink: ["file", "webhook"] });
    const o = overridesFromFlags({ ...a.flags, "state-dir": "/s", "log-format": "json" });
    expect(o).toEqual({ file: { path: "/x" }, sinks: ["file", "webhook"], state_dir: "/s", log_format: "json" });
    // --file and --file-content-max-chars together: neither drops the other
    const both = parseArgs(["acp", "--file", "/x", "--file-content-max-chars", "400"]);
    expect(overridesFromFlags(both.flags)).toEqual({ file: { path: "/x", content_max_chars: "400" } });
    expect(overridesFromFlags(parseArgs(["acp", "--file-content-max-chars=250"]).flags)).toEqual({ file: { content_max_chars: "250" } });
    expect(parseArgs([]).command).toBeUndefined();
    expect(parseArgs(["-h"]).flags.help).toBe(true);
    expect(parseArgs(["-v"]).flags.version).toBe(true);
    expect(parseArgs(["tail", "--no-thread"]).flags["no-thread"]).toBe(true);
    expect(overridesFromFlags(parseArgs(["--file-thread-context", "new", "--file-thread-context-max-chars", "10"]).flags).file).toEqual({
      thread_context: "new",
      thread_context_max_chars: "10",
    });
  });

  test("a value flag without a value, a boolean flag with one, or an unknown short option is an error", () => {
    expect(() => parseArgs(["--file"])).toThrow(/needs a value/);
    expect(() => parseArgs(["--file", "--no-follow"])).toThrow(/needs a value/);
    expect(() => parseArgs(["--no-follow=yes"])).toThrow(/does not take a value/);
    expect(() => parseArgs(["-x"])).toThrow(/unknown option/);
    expect(() => parseArgs(["--reset-allowlist"])).toThrow(/unknown option --reset-allowlist/);
    expect(() => parseArgs(["--flie=/x"])).toThrow(/unknown option --flie/);
  });
});

describe("main", () => {
  test("--help and --version exit 0; a bad flag or unknown command exits 1 with a hint", async () => {
    const h = io();
    expect(await main(["--help"], h)).toBe(0);
    expect(h.outLines[0]).toBe(HELP.trimEnd());
    expect(HELP).toContain("relay-backport tail");
    expect(HELP).toContain("--no-cursor");
    const v = io();
    expect(await main(["--version"], v)).toBe(0);
    expect(v.outLines[0]).toMatch(/^relay-backport \d+\.\d+\.\d+$/);
    const bad = io();
    expect(await main(["--file"], bad)).toBe(1);
    expect(bad.errLines.join("\n")).toContain("--help");
    const unknown = io();
    expect(await main(["watch"], unknown)).toBe(1);
    expect(unknown.errLines[0]).toContain('unknown command "watch"');
  });

  test("a config error exits 1 and prints the reason", async () => {
    const c = io({ RELAY_BACKPORT_SINKS: "webhook" });
    expect(await main(["acp"], c)).toBe(1);
    expect(c.errLines[0]).toContain("webhook.url");
    const l = io();
    expect(await main(["tail", "--lines", "-1"], l)).toBe(1);
    expect(l.errLines[0]).toContain("--lines");
  });

  test("acp over an in-process stdin: JSON-RPC on `out`, nothing else; exits 0 when stdin ends", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const file = join(t.dir, "d.jsonl");
    const stdin = new ReadableStream<Uint8Array>({
      start(ctl) {
        const enc = new TextEncoder();
        ctl.enqueue(enc.encode('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":2}}\n'));
        ctl.enqueue(enc.encode('{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/","mcpServers":[]}}\n'));
        ctl.close();
      },
    });
    const c = io({ RELAY_BACKPORT_FILE: file }, { stdin });
    expect(await main([], c)).toBe(0);
    expect(c.outLines.length).toBe(2);
    expect(JSON.parse(c.outLines[0]!).result.protocolVersion).toBe(2);
    expect(JSON.parse(c.outLines[1]!).result.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    const text = await Bun.file(file).text();
    expect(text).toContain("EVENT|session|new|");
    expect(text.trimEnd().endsWith("EVENT|acp|closed")).toBe(true);
  });

  test("tail follows the configured file and stops on abort; --no-follow prints and returns", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const file = join(t.dir, "d.jsonl");
    writeFileSync(file, "MENTION|{}\n");
    const ctl = new AbortController();
    const c = io({ RELAY_BACKPORT_FILE: file, RELAY_BACKPORT_STATE_DIR: t.dir }, { signal: ctl.signal });
    const run = main(["tail", "--no-cursor"], c);
    await Bun.sleep(80);
    appendFileSync(file, "EVENT|acp|closed\n");
    await waitFor(() => c.outLines.length === 1, 2000, "followed line");
    expect(c.outLines).toEqual(["EVENT|acp|closed"]);
    ctl.abort();
    expect(await run).toBe(0);

    const once = io({ RELAY_BACKPORT_STATE_DIR: t.dir });
    writeFileSync(join(t.dir, "deliveries.jsonl"), "a\nb\n");
    expect(await main(["tail", "--no-cursor", "--no-follow", "--lines", "1"], once)).toBe(0);
    expect(once.outLines).toEqual(["b"]);
  });

  test("tail keeps a cursor by default: it replays the gap, advances, and --cursor moves the file", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const file = join(t.dir, "deliveries.jsonl");
    writeFileSync(file, "MENTION|{\"a\":1}\nMENTION|{\"a\":2}\n");

    const first = io({ RELAY_BACKPORT_STATE_DIR: t.dir });
    expect(await main(["tail", "--no-follow"], first)).toBe(0);
    expect(first.outLines[0]).toContain("EVENT|catchup|2 line(s)");
    expect(first.outLines.slice(1)).toEqual(['MENTION|{"a":1}', 'MENTION|{"a":2}']);
    expect(await Bun.file(join(t.dir, "tail.cursor")).text()).toBe("2\n");

    // a second run over an unchanged file replays nothing
    const second = io({ RELAY_BACKPORT_STATE_DIR: t.dir });
    expect(await main(["tail", "--no-follow"], second)).toBe(0);
    expect(second.outLines).toEqual([]);

    // --cursor picks a different cursor file, which is cold, so everything replays
    const elsewhere = io({ RELAY_BACKPORT_STATE_DIR: t.dir });
    const other = join(t.dir, "other.cursor");
    expect(await main(["tail", "--no-follow", "--cursor", other], elsewhere)).toBe(0);
    expect(elsewhere.outLines.length).toBe(3);
    expect(await Bun.file(other).text()).toBe("2\n");
  });

  test("tail --no-thread prints MENTION lines without their thread context, and advances the cursor all the same", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const file = join(t.dir, "deliveries.jsonl");
    const withThread = `MENTION|${JSON.stringify({ kind: 9, from: "1a2b3c4d", h: "c", content: "hi", id: "e", tags: [], thread_context: [{ kind: "block", event_id: "e", at: 1, text: "history" }] })}`;
    writeFileSync(file, `EVENT|session|new|s1\n${withThread}\n`);

    const stripped = io({ RELAY_BACKPORT_STATE_DIR: t.dir });
    expect(await main(["tail", "--no-follow", "--no-thread"], stripped)).toBe(0);
    expect(stripped.outLines).toContain("EVENT|session|new|s1");
    const line = stripped.outLines.find((l) => l.startsWith("MENTION|"))!;
    expect(line).not.toContain("thread_context");
    expect(JSON.parse(line.slice("MENTION|".length))).toEqual({ kind: 9, from: "1a2b3c4d", h: "c", content: "hi", id: "e", tags: [] });
    // consumed, not skipped: the cursor counts both lines
    expect(await Bun.file(join(t.dir, "tail.cursor")).text()).toBe("2\n");

    // without the flag the field is on the line
    const whole = io({ RELAY_BACKPORT_STATE_DIR: t.dir });
    expect(await main(["tail", "--no-follow", "--cursor", join(t.dir, "other.cursor")], whole)).toBe(0);
    expect(whole.outLines.some((l) => l.includes("thread_context"))).toBe(true);
  });

  test("tail rejects --cursor with --no-cursor, and --lines with a cursor", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const both = io({ RELAY_BACKPORT_STATE_DIR: t.dir });
    expect(await main(["tail", "--cursor", join(t.dir, "c"), "--no-cursor"], both)).toBe(1);
    expect(both.errLines[0]).toContain("--cursor and --no-cursor");
    const lines = io({ RELAY_BACKPORT_STATE_DIR: t.dir });
    expect(await main(["tail", "--lines", "3"], lines)).toBe(1);
    expect(lines.errLines[0]).toContain("--no-cursor");
  });

  test("observe serves the page, ingests a delivery and stops on abort", async () => {
    const ctl = new AbortController();
    const c = io({}, { signal: ctl.signal });
    const run = main(["observe", "--port", "0", "--buffer", "5"], c);
    await waitFor(() => c.outLines.length === 1, 2000, "observe banner");
    const url = c.outLines[0]!.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
    expect(url).not.toBeNull();
    const port = url![1];
    const page = await fetch(`http://127.0.0.1:${port}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("what the agent would see");
    const ingest = await fetch(`http://127.0.0.1:${port}/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event_id: "a".repeat(64), prompt: "a prompt", session: { id: "s", cwd: "/tmp" } }),
    });
    expect(await ingest.json()).toEqual({ ok: true, seq: 1 });
    ctl.abort();
    expect(await run).toBe(0);
  });

  test("observe rejects a non-numeric or out-of-range --port / --buffer", async () => {
    expect(await main(["observe", "--port", "nope"], io())).toBe(1);
    expect(await main(["observe", "--buffer", "0"], io())).toBe(1);
    expect(HELP).toContain("relay-backport observe");
  });
});
