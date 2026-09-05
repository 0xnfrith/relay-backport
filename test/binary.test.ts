// Exercises a compiled binary end to end. Skipped unless RELAY_BACKPORT_BIN
// points at a binary that can run on this host (CI sets it after compiling).
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CHANNEL, SENDER, buzzFramedPrompt, spawnAcp, waitFor } from "./helpers/acp-client";
import { tmpDir } from "./helpers/tmp";

const BIN = process.env.RELAY_BACKPORT_BIN;
const enabled = Boolean(BIN && existsSync(BIN));
const run = enabled ? test : test.skip;

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function collect(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn([BIN!, ...args], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  cleanups.push(() => void proc.kill());
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

describe(`compiled binary${enabled ? "" : " (skipped: set RELAY_BACKPORT_BIN)"}`, () => {
  run("--help exits 0 and prints usage; --version prints the version", async () => {
    const h = await collect(["--help"]);
    expect(h.code).toBe(0);
    expect(h.stdout).toContain("USAGE");
    const v = await collect(["--version"]);
    expect(v.code).toBe(0);
    expect(v.stdout).toMatch(/relay-backport \d+\.\d+\.\d+/);
  });

  run("acp: a prompt lands in the file sink and `tail` prints it; an injected key never reaches a log", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const file = join(t.dir, "deliveries.jsonl");
    const key = "nsec1compiledbinaryinjectedkeymustnotleak";
    const c = spawnAcp(["acp"], { RELAY_BACKPORT_FILE: file, BUZZ_PRIVATE_KEY: key, RELAY_BACKPORT_LOG_FORMAT: "json" }, [BIN!]);
    cleanups.push(() => c.kill());
    expect((await c.request("initialize", { protocolVersion: 2 })).result).toMatchObject({ protocolVersion: 2 });
    const sid = ((await c.request("session/new", { cwd: "/", mcpServers: [] })).result as { sessionId: string }).sessionId;

    const tail = Bun.spawn([BIN!, "tail", "--file", file], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    cleanups.push(() => void tail.kill());
    const tailed: string[] = [];
    void (async () => {
      const reader = tail.stdout.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value);
        let nl = buf.indexOf("\n");
        while (nl >= 0) {
          tailed.push(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          nl = buf.indexOf("\n");
        }
      }
    })();
    await Bun.sleep(300);

    const eventId = "e".repeat(64);
    const r = await c.request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: buzzFramedPrompt({ eventId, channel: CHANNEL, sender: SENDER, content: "from the binary" }) }] });
    expect(r.result).toEqual({ stopReason: "end_turn" });
    await waitFor(() => tailed.some((l) => l.startsWith("MENTION|")), 8000, "tailed MENTION line");
    expect(JSON.parse(tailed.find((l) => l.startsWith("MENTION|"))!.slice(8))).toMatchObject({ id: eventId, from: SENDER.slice(0, 8), h: CHANNEL, content: "from the binary" });
    expect(await c.close()).toBe(0);
    expect(readFileSync(file, "utf8")).toContain("EVENT|acp|closed");
    expect(await c.stderr()).not.toContain(key);
    tail.kill();
  }, 30_000);
});
