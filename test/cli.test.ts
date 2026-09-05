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
    expect(parseArgs([]).command).toBeUndefined();
    expect(parseArgs(["-h"]).flags.help).toBe(true);
    expect(parseArgs(["-v"]).flags.version).toBe(true);
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
    const c = io({ RELAY_BACKPORT_FILE: file }, { signal: ctl.signal });
    const run = main(["tail"], c);
    await Bun.sleep(80);
    appendFileSync(file, "EVENT|acp|closed\n");
    await waitFor(() => c.outLines.length === 1, 2000, "followed line");
    expect(c.outLines).toEqual(["EVENT|acp|closed"]);
    ctl.abort();
    expect(await run).toBe(0);

    const once = io({ RELAY_BACKPORT_STATE_DIR: t.dir });
    writeFileSync(join(t.dir, "deliveries.jsonl"), "a\nb\n");
    expect(await main(["tail", "--no-follow", "--lines", "1"], once)).toBe(0);
    expect(once.outLines).toEqual(["b"]);
  });
});
