import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { HELP, main, overridesFromFlags, parseArgs } from "../src/cli";
import { configureLog } from "../src/log";
import { keypair } from "./helpers/mock-relay";
import { tmpDir } from "./helpers/tmp";

configureLog({ writer: () => {} });

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function io(env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return { out: (s: string) => out.push(s), err: (s: string) => err.push(s), env, outLines: out, errLines: err };
}

describe("argument parsing", () => {
  test("commands, positionals, value flags, booleans, repeatable --sink, --key=value", () => {
    const a = parseArgs(["allow", "add", "abc", "--mode", "any", "--note=hi there", "--json", "--sink", "stdout", "--sink=webhook"]);
    expect(a.command).toBe("allow");
    expect(a.positional).toEqual(["add", "abc"]);
    expect(a.flags).toEqual({ mode: "any", note: "hi there", json: true, sink: ["stdout", "webhook"] });
    expect(overridesFromFlags(a.flags).sinks).toEqual(["stdout", "webhook"]);
  });

  test("a value flag without a value, or a boolean flag with one, is an error", () => {
    expect(() => parseArgs(["watch", "--config"])).toThrow(/needs a value/);
    expect(() => parseArgs(["watch", "--reactions=yes"])).toThrow(/does not take a value/);
    expect(() => parseArgs(["-x"])).toThrow(/unknown option/);
  });
});

describe("cli exit codes", () => {
  test("--help and --version exit 0; no command exits 1 with help", async () => {
    let t = io();
    expect(await main(["--help"], t)).toBe(0);
    expect(t.outLines[0]).toBe(HELP.trimEnd());
    t = io();
    expect(await main(["--version"], t)).toBe(0);
    expect(t.outLines[0]).toMatch(/^relay-backport \d+\.\d+\.\d+/);
    t = io();
    expect(await main([], t)).toBe(1);
    t = io();
    expect(await main(["frobnicate"], t)).toBe(1);
    expect(t.errLines[0]).toMatch(/unknown command/);
  });

  test("watch with no relay configured exits 1 (config)", async () => {
    const t = io({});
    expect(await main(["watch"], t)).toBe(1);
    expect(t.errLines[0]).toMatch(/relay_url/);
  });

  test("watch with a bad key file exits 1 and never prints the key", async () => {
    const tmp = tmpDir();
    cleanups.push(tmp.cleanup);
    const keyFile = `${tmp.dir}/k`;
    writeFileSync(keyFile, "nsec1notvalidnotvalidnotvalidnotvalidnotvalidnotvalidnotvalidnotvalid");
    const t = io({ RELAY_URL: "wss://relay.example", PRIVATE_KEY_FILE: keyFile });
    expect(await main(["watch"], t)).toBe(1);
    expect(t.errLines.join("\n")).not.toContain("nsec1notvalid");
  });

  test("status / allow / stop without a daemon exit 4 (control refused)", async () => {
    const tmp = tmpDir();
    cleanups.push(tmp.cleanup);
    const env = { STATE_DIR: `${tmp.dir}/state` };
    expect(await main(["status"], io(env))).toBe(4);
    expect(await main(["allow", "list"], io(env))).toBe(4);
    expect(await main(["allow", "add", keypair().pk], io(env))).toBe(4);
    expect(await main(["stop"], io(env))).toBe(4);
    const t = io(env);
    expect(await main(["allow", "add"], t)).toBe(1);
    expect(t.errLines[0]).toMatch(/needs a pubkey/);
  });

  test("watch against an unreachable relay exits 2", async () => {
    const tmp = tmpDir();
    cleanups.push(tmp.cleanup);
    const keyFile = `${tmp.dir}/k`;
    writeFileSync(keyFile, keypair().hex);
    const t = io({ RELAY_URL: "ws://127.0.0.1:1", PRIVATE_KEY_FILE: keyFile, STATE_DIR: `${tmp.dir}/state`, CONTROL_PORT: "0" });
    expect(await main(["watch"], t)).toBe(2);
  });
});
