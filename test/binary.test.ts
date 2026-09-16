// Exercises a compiled binary end to end. Skipped unless RELAY_BACKPORT_BIN
// points at a binary that can run on this host (CI sets it after compiling).
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { CHANNEL_A, MockRelay, channelMessage, keypair, membersEvent, metadataEvent, waitFor } from "./helpers/mock-relay";
import { tmpDir } from "./helpers/tmp";
import { loadState, saveAllowlist } from "../src/state";
import { configureLog } from "../src/log";

configureLog({ writer: () => {} });

const BIN = process.env.RELAY_BACKPORT_BIN;
const enabled = Boolean(BIN && existsSync(BIN));
const run = enabled ? test : test.skip;

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

function spawn(args: string[], env: Record<string, string>) {
  const proc = Bun.spawn([BIN!, ...args], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  cleanups.push(() => {
    try {
      proc.kill();
    } catch {
      // gone
    }
  });
  return proc;
}

async function collect(proc: ReturnType<typeof spawn>) {
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

describe(`compiled binary${enabled ? "" : " (skipped: set RELAY_BACKPORT_BIN)"}`, () => {
  run("--help exits 0 and prints usage; --version prints the version", async () => {
    const h = await collect(spawn(["--help"], {}));
    expect(h.code).toBe(0);
    expect(h.stdout).toContain("USAGE");
    const v = await collect(spawn(["--version"], {}));
    expect(v.code).toBe(0);
    expect(v.stdout).toMatch(/relay-backport \d+\.\d+\.\d+/);
  });

  run("watch --sink stdout: mention → MENTION line; disallowed sender dropped; status via the CLI", async () => {
    const relay = new MockRelay({ requireAuth: true });
    cleanups.push(() => relay.stop());
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const bot = keypair();
    const owner = keypair();
    const relaySk = keypair().sk;
    const keyFile = `${t.dir}/bot.key`;
    writeFileSync(keyFile, bot.hex);
    relay.store(membersEvent(relaySk, CHANNEL_A, [bot.pk]));
    relay.store(metadataEvent(relaySk, CHANNEL_A));
    const env = {
      RELAY_URL: relay.url,
      PRIVATE_KEY_FILE: keyFile,
      STATE_DIR: `${t.dir}/state`,
      OWNER_PUBKEY: owner.pk,
      CONTROL_PORT: "0",
    };
    const daemon = spawn(["watch", "--sink", "stdout"], env);
    const lines: string[] = [];
    void (async () => {
      const reader = daemon.stdout.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value);
        let nl = buf.indexOf("\n");
        while (nl >= 0) {
          lines.push(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          nl = buf.indexOf("\n");
        }
      }
    })();
    await waitFor(() => relay.reqsWithPrefix("watch").length >= 1, 15_000, "daemon subscribed");

    relay.publish(channelMessage(keypair().sk, CHANNEL_A, "stranger", [["p", bot.pk]]));
    const m = channelMessage(owner.sk, CHANNEL_A, "owner here", [["p", bot.pk]]);
    relay.publish(m);
    await waitFor(() => lines.some((l) => l.startsWith("MENTION|")), 10_000, "MENTION line");
    const mentions = lines.filter((l) => l.startsWith("MENTION|"));
    expect(mentions.length).toBe(1);
    expect(JSON.parse(mentions[0]!.slice(8)).id).toBe(m.id);

    const status = await collect(spawn(["status", "--json"], env));
    expect(status.code).toBe(0);
    const parsed = JSON.parse(status.stdout);
    expect(parsed.connected).toBe(true);
    expect(parsed.counters.dropped_not_allowed).toBe(1);
    expect(parsed.counters.delivered).toBe(1);

    const add = await collect(spawn(["allow", "add", owner.pk.replace(/./g, "a"), "--mode", "any", "--note", "test"], env));
    expect(add.code).toBe(0);
    const list = await collect(spawn(["allow", "list"], env));
    expect(list.code).toBe(0);
    expect(list.stdout).toContain("aaaaaaaa");

    const stop = await collect(spawn(["stop"], env));
    expect(stop.code).toBe(0);
    expect(await daemon.exited).toBe(0);
  });

  run("watch → webhook sink delivers; tampered state file → refused (exit 1)", async () => {
    const relay = new MockRelay({ requireAuth: true });
    cleanups.push(() => relay.stop());
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const bot = keypair();
    const owner = keypair();
    const relaySk = keypair().sk;
    const keyFile = `${t.dir}/bot.key`;
    writeFileSync(keyFile, bot.hex);
    relay.store(membersEvent(relaySk, CHANNEL_A, [bot.pk]));
    relay.store(metadataEvent(relaySk, CHANNEL_A));
    const got: unknown[] = [];
    const hook = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        got.push(await req.json());
        return new Response("ok");
      },
    });
    cleanups.push(() => hook.stop(true));
    const env = {
      RELAY_URL: relay.url,
      PRIVATE_KEY_FILE: keyFile,
      STATE_DIR: `${t.dir}/state`,
      OWNER_PUBKEY: owner.pk,
      CONTROL_PORT: "0",
      SINKS: "webhook",
      WEBHOOK_URL: `http://127.0.0.1:${hook.port}/h`,
    };
    const daemon = spawn(["watch"], env);
    await waitFor(() => relay.reqsWithPrefix("watch").length >= 1, 15_000, "daemon subscribed");
    relay.publish(channelMessage(owner.sk, CHANNEL_A, "hook me", [["p", bot.pk]]));
    await waitFor(() => got.length === 1, 10_000, "webhook delivery");
    expect((got[0] as { text: string }).text).toBe("hook me");
    await collect(spawn(["stop"], env));
    expect(await daemon.exited).toBe(0);

    // remove the signing key but leave a non-empty allowlist → refuse
    const st = loadState({ stateDir: env.STATE_DIR });
    st.allowlist.add(keypair().pk, "any");
    saveAllowlist(st.paths, st.allowlist);
    const { unlinkSync } = await import("node:fs");
    unlinkSync(st.paths.signingKey);
    const refused = await collect(spawn(["watch"], env));
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("signing.key is missing");
  });
});
