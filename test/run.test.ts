import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { main } from "../src/cli";
import { describeConfig, loadConfig } from "../src/config";
import {
  buildPlan,
  httpsFromRelay,
  isHarnessKey,
  KEY_COMMAND_TIMEOUT_MS,
  KEY_ENV,
  mergeAllowlist,
  preflight,
  pubkeysFromStore,
  readKeyFromCommand,
  renderPlan,
  resolveBinary,
  runHarness,
  selfInvocation,
} from "../src/run";
import { tmpDir } from "./helpers/tmp";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

// Obviously-fake pubkeys: this repo is public, and a plausible-looking one in
// a fixture is a pubkey someone will copy.
const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);
const CAROL = "c".repeat(64);
const SECRET = "d".repeat(64);

/** A key file with a real secret's shape and mode, and no real secret in it. */
function keyFile(dir: string): string {
  const p = join(dir, "agent.key");
  writeFileSync(p, `${SECRET}\n`, { mode: 0o600 });
  chmodSync(p, 0o600);
  return p;
}

function fakeBinary(dir: string, name = "buzz-acp"): string {
  const p = join(dir, name);
  writeFileSync(p, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return p;
}

function writeExec(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body, { mode: 0o755 });
  chmodSync(p, 0o755);
  return p;
}

function runConfig(dir: string, extra: Record<string, unknown> = {}) {
  const useCommand = Object.prototype.hasOwnProperty.call(extra, "key_command");
  const cfg = loadConfig({
    env: {},
    overrides: {
      state_dir: dir,
      run: {
        buzz_acp: fakeBinary(dir),
        ...(useCommand ? {} : { key_file: keyFile(dir) }),
        relay_url: "wss://relay.example",
        owner: ALICE,
        allowlist: [ALICE, BOB],
        ...extra,
      },
    },
  });
  return cfg;
}

function io(env: Record<string, string | undefined> = {}) {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return { out: (s: string) => outLines.push(s), err: (s: string) => errLines.push(s), env, outLines, errLines };
}

describe("run: helpers", () => {
  test("resolveBinary takes a path as given and looks a bare name up on PATH", () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const bin = fakeBinary(t.dir);
    expect(resolveBinary(bin, {})).toBe(bin);
    expect(resolveBinary("buzz-acp", { PATH: `/nope${require("node:path").delimiter}${t.dir}` })).toBe(bin);
    expect(resolveBinary("buzz-acp", { PATH: "/nope" })).toBeUndefined();
    expect(resolveBinary("/absent/buzz-acp", {})).toBeUndefined();
  });

  test("selfInvocation points a runtime at a script, and a compiled build at itself", () => {
    expect(selfInvocation("/usr/bin/bun", "/app/src/cli.ts")).toEqual({ command: "/usr/bin/bun", prefixArgs: ["/app/src/cli.ts"] });
    expect(selfInvocation("/usr/local/bin/relay-backport", "/$bunfs/root/cli")).toEqual({ command: "/usr/local/bin/relay-backport", prefixArgs: [] });
  });

  test("pubkeysFromStore reads the JSON store shape and ignores everything else", () => {
    expect(pubkeysFromStore(JSON.stringify({ entries: [{ pubkey: ALICE }, { pubkey: "nope" }, {}] }))).toEqual([ALICE]);
    expect(pubkeysFromStore("not json")).toEqual([]);
    expect(pubkeysFromStore(JSON.stringify({ entries: "no" }))).toEqual([]);
    expect(pubkeysFromStore(JSON.stringify({ entries: [{ pubkey: ALICE.toUpperCase() }] }))).toEqual([ALICE]);
  });

  test("mergeAllowlist keeps config order, appends the store, de-duplicates and drops non-hex", () => {
    expect(mergeAllowlist([ALICE, BOB], [BOB, CAROL])).toEqual([ALICE, BOB, CAROL]);
    expect(mergeAllowlist(["  " + ALICE.toUpperCase() + "  "], [])).toEqual([ALICE]);
    expect(mergeAllowlist(["@someone", ""], [ALICE])).toEqual([ALICE]);
  });

  test("httpsFromRelay maps the websocket scheme onto the one a NIP-11 probe can use", () => {
    expect(httpsFromRelay("wss://relay.example")).toBe("https://relay.example");
    expect(httpsFromRelay("ws://127.0.0.1:7777")).toBe("http://127.0.0.1:7777");
    expect(httpsFromRelay("https://relay.example")).toBe("https://relay.example");
    expect(httpsFromRelay("relay.example")).toBeUndefined();
  });
});

describe("run: the plan", () => {
  test("config parses into a plan with the whole child environment, and the sinks reach it twice", () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const cfg = runConfig(t.dir);
    const plan = buildPlan({
      run: cfg.run,
      stateDir: cfg.stateDir,
      sinks: cfg.sinks,
      observe: false,
      env: {},
      execPath: "/usr/bin/bun",
      mainPath: "/app/src/cli.ts",
    });
    expect(plan.args).toEqual(["--session-title", "relay-backport-ears", "--no-memory", "--lazy-pool", "--no-typing", "--multiple-event-handling", "queue"]);
    expect(plan.env.BUZZ_RELAY_URL).toBe("wss://relay.example");
    expect(plan.env.BUZZ_ACP_AGENT_OWNER).toBe(ALICE);
    expect(plan.env.BUZZ_ACP_RESPOND_TO).toBe("allowlist");
    expect(plan.env.BUZZ_ACP_RESPOND_TO_ALLOWLIST).toBe(`${ALICE},${BOB}`);
    expect(plan.env.BUZZ_ACP_AGENT_COMMAND).toBe("/usr/bin/bun");
    expect(plan.env.BUZZ_ACP_AGENT_ARGS).toBe(`/app/src/cli.ts,acp,--state-dir,${t.dir},--sink,file`);
    expect(plan.env.BUZZ_ACP_SESSION_POLICY).toBe("thread");
    expect(plan.env.RELAY_BACKPORT_SINKS).toBe("file");
    expect(plan.env.RELAY_BACKPORT_WEBHOOK_URL).toBeUndefined();
    expect(plan.keyBytes).toBe(65);
  });

  test("agent args carry --config when a config path is given, and not when it is absent", () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const cfg = runConfig(t.dir);
    const without = buildPlan({
      run: cfg.run,
      stateDir: cfg.stateDir,
      sinks: cfg.sinks,
      observe: false,
      env: {},
      execPath: "/usr/bin/bun",
      mainPath: "/app/src/cli.ts",
    });
    expect(without.env.BUZZ_ACP_AGENT_ARGS).toBe(`/app/src/cli.ts,acp,--state-dir,${t.dir},--sink,file`);
    expect(without.env.BUZZ_ACP_AGENT_ARGS).not.toContain("--config");
    expect(without.env.RELAY_BACKPORT_CONFIG).toBeUndefined();

    const configPath = join(t.dir, "rb.toml");
    const withCfg = buildPlan({
      run: cfg.run,
      stateDir: cfg.stateDir,
      sinks: cfg.sinks,
      observe: false,
      env: {},
      execPath: "/usr/bin/bun",
      mainPath: "/app/src/cli.ts",
      configPath,
    });
    expect(withCfg.env.BUZZ_ACP_AGENT_ARGS).toBe(`/app/src/cli.ts,acp,--state-dir,${t.dir},--sink,file,--config,${configPath}`);
    expect(withCfg.env.RELAY_BACKPORT_CONFIG).toBe(configPath);
    expect(renderPlan(withCfg)).toContain(`--config,${configPath}`);
    expect(renderPlan(withCfg)).toContain(`RELAY_BACKPORT_CONFIG`);
  });

  test("--observe adds the webhook sink and points it at the local ingest endpoint", () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const cfg = runConfig(t.dir);
    const plan = buildPlan({
      run: cfg.run,
      stateDir: cfg.stateDir,
      sinks: cfg.sinks,
      observe: true,
      env: {},
      execPath: "/usr/bin/bun",
      mainPath: "/app/src/cli.ts",
    });
    expect(plan.sinks).toEqual(["file", "webhook"]);
    expect(plan.env.BUZZ_ACP_AGENT_ARGS).toContain("--sink,file,--sink,webhook");
    expect(plan.env.RELAY_BACKPORT_SINKS).toBe("file,webhook");
    expect(plan.env.RELAY_BACKPORT_WEBHOOK_URL).toBe("http://127.0.0.1:7479/ingest");
  });

  test("run.allowlist_file is merged into the list, and an empty allowlist is a config error", () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const store = join(t.dir, "allowlist.json");
    writeFileSync(store, JSON.stringify({ entries: [{ pubkey: BOB }, { pubkey: CAROL }] }));
    const cfg = runConfig(t.dir, { allowlist: [ALICE], allowlist_file: store });
    const plan = buildPlan({ run: cfg.run, stateDir: cfg.stateDir, sinks: cfg.sinks, observe: false, env: {}, execPath: "/b", mainPath: "/m" });
    expect(plan.env.BUZZ_ACP_RESPOND_TO_ALLOWLIST).toBe(`${ALICE},${BOB},${CAROL}`);

    const empty = runConfig(t.dir, { allowlist: [] });
    expect(() => buildPlan({ run: empty.run, stateDir: empty.stateDir, sinks: empty.sinks, observe: false, env: {}, execPath: "/b", mainPath: "/m" })).toThrow(/allowlist/);
  });

  test("a missing buzz-acp is a config error naming the setting", () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const cfg = runConfig(t.dir, { buzz_acp: join(t.dir, "absent") });
    expect(() => buildPlan({ run: cfg.run, stateDir: cfg.stateDir, sinks: cfg.sinks, observe: false, env: {}, execPath: "/b", mainPath: "/m" })).toThrow(/run\.buzz_acp|BUZZ_ACP_BIN/);
  });

  test("the rendered plan carries the key's origin and size but never its value", () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const cfg = runConfig(t.dir);
    const plan = buildPlan({ run: cfg.run, stateDir: cfg.stateDir, sinks: cfg.sinks, observe: false, env: {}, execPath: "/usr/bin/bun", mainPath: "/app/src/cli.ts" });
    const text = renderPlan(plan);
    expect(text).toContain(`${KEY_ENV}`);
    expect(text).toContain(`<from ${cfg.run.keyFile}, 65 bytes>`);
    expect(text).not.toContain(SECRET);
    // the public material is printed in full
    expect(text).toContain(ALICE);
    expect(text).toContain("wss://relay.example");
  });
});

describe("run: preflight", () => {
  const plan = (dir: string, observe = false) => {
    const cfg = runConfig(dir);
    return { cfg, plan: buildPlan({ run: cfg.run, stateDir: cfg.stateDir, sinks: cfg.sinks, observe, env: {}, execPath: "/b", mainPath: "/m" }) };
  };

  test("a well-formed setup passes every check", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const { cfg, plan: p } = plan(t.dir);
    const lines = await preflight({
      plan: p,
      run: cfg.run,
      stateDir: cfg.stateDir,
      observe: false,
      probe: async () => true,
      duplicateSessionTitle: async () => false,
    });
    expect(lines.every((l) => l.level === "OK")).toBe(true);
    expect(lines.map((l) => l.text).join("\n")).toContain("contents never printed");
  });

  test("a key file with the wrong mode fails, and a relay that does not answer only warns", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const { cfg, plan: p } = plan(t.dir);
    chmodSync(cfg.run.keyFile, 0o644);
    const lines = await preflight({
      plan: p,
      run: cfg.run,
      stateDir: cfg.stateDir,
      observe: false,
      probe: async () => false,
      duplicateSessionTitle: async () => false,
    });
    const fails = lines.filter((l) => l.level === "FAIL");
    expect(fails.length).toBe(1);
    expect(fails[0]!.text).toContain("mode is 0644");
    expect(lines.some((l) => l.level === "WARN" && l.text.includes("relay did not answer"))).toBe(true);
  });

  test("a duplicate session title fails; an unknowable one warns; --observe fails when the page is down", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const { cfg, plan: p } = plan(t.dir, true);
    const dup = await preflight({ plan: p, run: cfg.run, stateDir: cfg.stateDir, observe: false, probe: async () => true, duplicateSessionTitle: async () => true });
    expect(dup.some((l) => l.level === "FAIL" && l.text.includes("already running"))).toBe(true);

    const unknown = await preflight({ plan: p, run: cfg.run, stateDir: cfg.stateDir, observe: false, probe: async () => true, duplicateSessionTitle: async () => undefined });
    expect(unknown.some((l) => l.level === "WARN" && l.text.includes("could not check"))).toBe(true);

    const pageDown = await preflight({
      plan: p,
      run: cfg.run,
      stateDir: cfg.stateDir,
      observe: true,
      // the page probe is the only one that returns false here
      probe: async (url) => !url.startsWith("http://127.0.0.1:7479"),
      duplicateSessionTitle: async () => false,
    });
    expect(pageDown.some((l) => l.level === "FAIL" && l.text.includes("observe page not up"))).toBe(true);
  });
});

describe("run: the CLI", () => {
  test("--dry-run preflights, prints the plan, starts nothing and never prints the key", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const config = join(t.dir, "rb.json");
    writeFileSync(
      config,
      JSON.stringify({
        state_dir: t.dir,
        run: {
          buzz_acp: fakeBinary(t.dir),
          key_file: keyFile(t.dir),
          // a port nothing listens on, so the probe fails immediately rather than hanging
          relay_url: "ws://127.0.0.1:1",
          owner: ALICE,
          allowlist: [ALICE, BOB],
        },
      }),
    );
    const c = io();
    expect(await main(["run", "--dry-run", "--config", config], c)).toBe(0);
    const text = c.outLines.join("\n");
    expect(text).toContain("PREFLIGHT");
    expect(text).toContain("PLAN — exec");
    expect(text).toContain(`--config,${config}`);
    expect(text).toContain(`RELAY_BACKPORT_CONFIG`);
    expect(text).toContain("--dry-run: stopping here");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("EARS UP");
  });

  test("a relative config path is forwarded absolute; RELAY_BACKPORT_CONFIG without --config is enough", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const configAbs = join(t.dir, "rb.json");
    writeFileSync(
      configAbs,
      JSON.stringify({
        state_dir: t.dir,
        run: {
          buzz_acp: fakeBinary(t.dir),
          key_file: keyFile(t.dir),
          relay_url: "ws://127.0.0.1:1",
          owner: ALICE,
          allowlist: [ALICE, BOB],
        },
      }),
    );
    const configRel = relative(process.cwd(), configAbs);
    expect(isAbsolute(configRel)).toBe(false);
    const c = io({ RELAY_BACKPORT_CONFIG: configRel });
    expect(await main(["run", "--dry-run"], c)).toBe(0);
    const text = c.outLines.join("\n");
    expect(text).toContain(`--config,${configAbs}`);
    expect(text).toContain(`RELAY_BACKPORT_CONFIG`);
  });

  test("run without run.key_file or run.key_command is a usage error naming both", async () => {
    const c = io();
    expect(await main(["run"], c)).toBe(1);
    expect(c.errLines[0]).toContain("run.key_file");
    expect(c.errLines[0]).toContain("run.key_command");
  });

  test("runHarness puts the key in the child's environment and nowhere else", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const cfg = runConfig(t.dir);
    const p = buildPlan({ run: cfg.run, stateDir: cfg.stateDir, sinks: cfg.sinks, observe: false, env: {}, execPath: "/b", mainPath: "/m" });
    let seen: { command: string; args: string[]; env: Record<string, string> } | undefined;
    const code = await runHarness({
      plan: p,
      run: cfg.run,
      stateDir: cfg.stateDir,
      env: { PATH: "/usr/bin", HOME: t.dir },
      out: () => {},
      spawn: async (command, args, env) => {
        seen = { command, args, env };
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(seen!.env[KEY_ENV]).toBe(SECRET);
    expect(seen!.args.join(" ")).not.toContain(SECRET);
    expect(seen!.command).not.toContain(SECRET);
    // the parent's environment is inherited, not replaced
    expect(seen!.env.HOME).toBe(t.dir);
  });
});

describe("run: key command", () => {
  const planOf = (dir: string, extra: Record<string, unknown> = {}, env: Record<string, string | undefined> = {}) => {
    const cfg = runConfig(dir, extra);
    return {
      cfg,
      plan: buildPlan({ run: cfg.run, stateDir: cfg.stateDir, sinks: cfg.sinks, observe: false, env, execPath: "/b", mainPath: "/m" }),
    };
  };

  test("a 64-hex string and an nsec1… pass the format check; anything else does not", () => {
    expect(KEY_COMMAND_TIMEOUT_MS).toBe(30_000);
    expect(isHarnessKey(SECRET)).toBe(true);
    expect(isHarnessKey(`nsec1${"q".repeat(58)}`)).toBe(true);
    expect(isHarnessKey("not-a-key")).toBe(false);
    expect(isHarnessKey(`nsec1${"I".repeat(40)}`)).toBe(false);
    expect(isHarnessKey(`${SECRET}\n`)).toBe(false);
  });

  test("RELAY_BACKPORT_RUN_KEY_COMMAND is an argv array and describeConfig logs only argv[0]", () => {
    const cfg = loadConfig({
      env: { RELAY_BACKPORT_RUN_KEY_COMMAND: "op read op://vault/item/credential" },
    });
    expect(cfg.run.keyCommand).toEqual(["op", "read", "op://vault/item/credential"]);
    expect(cfg.run.keyFile).toBe("");
    const described = JSON.stringify(describeConfig(cfg));
    expect(described).toContain('"key_command":"op"');
    expect(described).not.toContain("op://");
    expect(described).not.toContain("credential");

    const fromToml = loadConfig({
      configPath: "/etc/relay-backport.toml",
      env: {},
      readFile: () => '[run]\nkey_command = ["op", "read", "op://vault/item/credential"]\n',
    });
    expect(fromToml.run.keyCommand).toEqual(["op", "read", "op://vault/item/credential"]);
  });

  test("the default timeout passed to the command is 30s, and a good stdout is trimmed", async () => {
    let seenTimeout = 0;
    const key = await readKeyFromCommand(["op", "read", "op://vault/item/credential"], {
      spawn: async (_argv, timeoutMs) => {
        seenTimeout = timeoutMs;
        return { code: 0, stdout: `  ${SECRET}\n`, timedOut: false, overflow: false };
      },
    });
    expect(seenTimeout).toBe(30_000);
    expect(key).toBe(SECRET);
  });

  test("the plan names argv[0] and preflight resolves a bare name on PATH without running it", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const binDir = join(t.dir, "bin");
    mkdirSync(binDir);
    const script = writeExec(binDir, "print-key", "#!/bin/sh\nexit 7\n");
    const { cfg, plan } = planOf(t.dir, { key_command: ["print-key", "op://vault/item/credential"] }, { PATH: binDir });
    expect(plan.keyCommandPath).toBe(script);
    expect(plan.keyBytes).toBeUndefined();
    const text = renderPlan(plan);
    expect(text).toContain("<from key_command: print-key>");
    expect(text).not.toContain("op://vault/item/credential");
    expect(text).not.toContain(SECRET);
    const lines = await preflight({ plan, run: cfg.run, stateDir: cfg.stateDir, observe: false });
    expect(lines.some((l) => l.level === "OK" && l.text === "key command executable: print-key (not run)")).toBe(true);
    expect(lines.some((l) => l.level === "FAIL")).toBe(false);
  });

  test("a missing key command fails preflight, and a non-executable one does too", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const missing = planOf(t.dir, { key_command: ["no-such-relay-backport-key-cmd"] });
    const missingLines = await preflight({ plan: missing.plan, run: missing.cfg.run, stateDir: missing.cfg.stateDir, observe: false });
    expect(missingLines.some((l) => l.level === "FAIL" && l.text.includes("key command not found: no-such-relay-backport-key-cmd"))).toBe(true);

    const script = writeExec(t.dir, "print-key", "#!/bin/sh\nexit 0\n");
    chmodSync(script, 0o644);
    const blocked = planOf(t.dir, { key_command: [script] });
    const blockedLines = await preflight({ plan: blocked.plan, run: blocked.cfg.run, stateDir: blocked.cfg.stateDir, observe: false });
    expect(blockedLines.some((l) => l.level === "FAIL" && l.text.includes("not executable"))).toBe(true);
  });

  test("a good key command puts the trimmed key in the child environment and nowhere else", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const script = writeExec(t.dir, "print-key", `#!/bin/sh\nprintf '%s\\n' '${SECRET}'\n`);
    const { cfg, plan } = planOf(t.dir, { key_command: [script] });
    let seen: { command: string; args: string[]; env: Record<string, string> } | undefined;
    const outs: string[] = [];
    const code = await runHarness({
      plan,
      run: cfg.run,
      stateDir: cfg.stateDir,
      env: { PATH: "/usr/bin", HOME: t.dir },
      out: (s) => outs.push(s),
      spawn: async (command, args, env) => {
        seen = { command, args, env };
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(seen!.env[KEY_ENV]).toBe(SECRET);
    expect(seen!.args.join(" ")).not.toContain(SECRET);
    expect(seen!.command).not.toContain(SECRET);
    expect(outs.join("\n")).not.toContain(SECRET);
    expect(outs.join("\n")).toContain("EARS UP");
    expect(renderPlan(plan)).not.toContain(SECRET);
  });

  test("empty stdout fails and the child is never spawned", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const script = writeExec(t.dir, "print-key", "#!/bin/sh\nprintf '\\n'\n");
    const { cfg, plan } = planOf(t.dir, { key_command: [script] });
    let spawned = false;
    let message = "";
    try {
      await runHarness({
        plan,
        run: cfg.run,
        stateDir: cfg.stateDir,
        env: {},
        out: () => {},
        spawn: async () => {
          spawned = true;
          return 0;
        },
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("produced no key");
    expect(spawned).toBe(false);
  });

  test("a bad format fails and the error does not contain the output", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const leak = "not-a-key-should-not-leak";
    const script = writeExec(t.dir, "print-key", `#!/bin/sh\nprintf '%s\\n' '${leak}'\n`);
    const { cfg, plan } = planOf(t.dir, { key_command: [script] });
    let message = "";
    try {
      await runHarness({ plan, run: cfg.run, stateDir: cfg.stateDir, env: {}, out: () => {} });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("not a 64-hex");
    expect(message).not.toContain(leak);
    expect(message).not.toContain("EARS UP");
  });

  test("a non-zero exit fails and the error contains neither stdout nor stderr", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const leak = "stdout-leak-should-not-appear";
    const errLeak = "stderr-leak-should-not-appear";
    const script = writeExec(t.dir, "print-key", `#!/bin/sh\nprintf '%s\\n' '${leak}'\nprintf '%s\\n' '${errLeak}' >&2\nexit 3\n`);
    const { cfg, plan } = planOf(t.dir, { key_command: [script] });
    let message = "";
    try {
      await runHarness({ plan, run: cfg.run, stateDir: cfg.stateDir, env: {}, out: () => {} });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("exit 3");
    expect(message).not.toContain(leak);
    expect(message).not.toContain(errLeak);
  });

  test("a timeout fails without echoing partial output", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const leak = "timeout-leak-should-not-appear";
    const script = writeExec(t.dir, "print-key", `#!/bin/sh\nprintf '%s\\n' '${leak}'\nexec sleep 30\n`);
    const { cfg, plan } = planOf(t.dir, { key_command: [script] });
    const started = Date.now();
    let message = "";
    try {
      await runHarness({
        plan,
        run: cfg.run,
        stateDir: cfg.stateDir,
        env: {},
        out: () => {},
        keyCommandTimeoutMs: 400,
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("timed out after 400ms");
    expect(message).not.toContain(leak);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);

  test("setting both key_file and key_command is a config error", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const config = join(t.dir, "rb.json");
    writeFileSync(
      config,
      JSON.stringify({
        state_dir: t.dir,
        run: {
          buzz_acp: fakeBinary(t.dir),
          key_file: keyFile(t.dir),
          key_command: [writeExec(t.dir, "print-key", "#!/bin/sh\nexit 0\n")],
          relay_url: "ws://127.0.0.1:1",
          allowlist: [ALICE],
        },
      }),
    );
    const c = io();
    expect(await main(["run", "--dry-run", "--config", config], c)).toBe(1);
    const err = c.errLines.join("\n");
    expect(err).toContain("mutually exclusive");
    expect(err).not.toContain(SECRET);
    expect(() =>
      loadConfig({
        env: { RELAY_BACKPORT_RUN_KEY_COMMAND: "op read op://vault/item/credential" },
        overrides: { run: { key_file: "/tmp/agent.key" } },
      }),
    ).toThrow(/mutually exclusive/);
  });

  test("--dry-run never runs the key command", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const marker = join(t.dir, "key-command-ran");
    const script = writeExec(t.dir, "print-key", `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nprintf '%s\\n' '${SECRET}'\n`);
    const config = join(t.dir, "rb.json");
    writeFileSync(
      config,
      JSON.stringify({
        state_dir: t.dir,
        run: {
          buzz_acp: fakeBinary(t.dir),
          key_command: [script],
          relay_url: "ws://127.0.0.1:1",
          owner: ALICE,
          allowlist: [ALICE, BOB],
        },
      }),
    );
    const c = io();
    expect(await main(["run", "--dry-run", "--config", config], c)).toBe(0);
    const text = c.outLines.join("\n");
    expect(existsSync(marker)).toBe(false);
    expect(text).toContain(`<from key_command: ${script}>`);
    expect(text).toContain("key command executable");
    expect(text).toContain("(not run)");
    expect(text).toContain("--dry-run: stopping here");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("EARS UP");
  });
});
