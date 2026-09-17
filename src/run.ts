// `relay-backport run` — the launcher.
//
// Running relay-backport headlessly means running `buzz-acp` with a dozen
// environment variables set exactly right, which in practice meant an
// operator-maintained shell script per machine. This command absorbs that
// script: it builds the child's environment from config, preflights what can
// be preflighted, prints a redacted plan, and execs `buzz-acp` in the
// foreground so the terminal running it IS the daemon.
//
// The one secret — the agent's private key — is read from a file and put in
// the child's environment and nowhere else: never on a command line (where
// `ps` would show it), never in a log line, never in the printed plan. The
// only values this file prints are public keys, paths and byte counts.
import { accessSync, constants, existsSync, mkdirSync, statSync } from "node:fs";
import { readFileSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { RunConfig, SinkName } from "./config";
import { ConfigError } from "./config";
import { registerSecret } from "./log";

export const KEY_ENV = "BUZZ_PRIVATE_KEY";
/** A plausible secret key: 64 hex characters, or an `nsec1…` bech32 string, with slack for whitespace. */
export const KEY_MIN_BYTES = 32;
export const KEY_MAX_BYTES = 200;

export type PreflightLine = { level: "OK" | "WARN" | "FAIL"; text: string };

export type RunPlan = {
  /** The `buzz-acp` binary, resolved. */
  command: string;
  /** Its arguments, in order. */
  args: string[];
  /** The child's environment additions — WITHOUT the key, which is added at spawn time. */
  env: Record<string, string>;
  /** Where the key comes from, and how big it is. Its VALUE is never part of a plan. */
  keyFile: string;
  keyBytes?: number;
  /** The sinks the relay-backport child is told to use. */
  sinks: SinkName[];
};

/** `PATH` lookup for a bare command name, so a plan always names a real file. */
export function resolveBinary(name: string, env: Record<string, string | undefined>, exists: (p: string) => boolean = existsSync): string | undefined {
  if (name.includes("/") || name.includes("\\")) return exists(name) ? resolve(name) : undefined;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

/**
 * The command and leading arguments that re-invoke THIS program. A compiled
 * single-file build is its own executable; a source checkout is a script the
 * runtime has to be pointed at, so the script path leads the arguments.
 */
export function selfInvocation(execPath: string, mainPath: string): { command: string; prefixArgs: string[] } {
  if (/\.(ts|tsx|js|mjs|cjs)$/.test(mainPath)) return { command: execPath, prefixArgs: [mainPath] };
  return { command: execPath, prefixArgs: [] };
}

/** The allowlist store the launcher reads: `{ "entries": [{ "pubkey": "…" }, …] }`. Any other shape yields nothing. */
export function pubkeysFromStore(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const entries = (parsed as { entries?: unknown })?.entries;
  if (!Array.isArray(entries)) return [];
  const out: string[] = [];
  for (const e of entries) {
    const pk = (e as { pubkey?: unknown })?.pubkey;
    if (typeof pk === "string" && /^[0-9a-f]{64}$/i.test(pk.trim())) out.push(pk.trim().toLowerCase());
  }
  return out;
}

/**
 * The allowlist the child is given: the configured list first, then whatever
 * the store adds, de-duplicated, order preserved. Non-hex entries are dropped
 * rather than passed through — `buzz-acp`'s gate takes hex pubkeys only, and a
 * malformed entry there fails open-endedly rather than loudly.
 */
export function mergeAllowlist(list: string[], storeKeys: string[]): string[] {
  const out: string[] = [];
  for (const raw of [...list, ...storeKeys]) {
    const pk = raw.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(pk)) continue;
    if (!out.includes(pk)) out.push(pk);
  }
  return out;
}

/** `wss://host` → `https://host`, so the relay can be probed for its NIP-11 document. */
export function httpsFromRelay(url: string): string | undefined {
  if (url.startsWith("wss://")) return `https://${url.slice("wss://".length)}`;
  if (url.startsWith("ws://")) return `http://${url.slice("ws://".length)}`;
  if (url.startsWith("https://") || url.startsWith("http://")) return url;
  return undefined;
}

export type BuildPlanOptions = {
  run: RunConfig;
  stateDir: string;
  sinks: SinkName[];
  observe: boolean;
  env: Record<string, string | undefined>;
  execPath: string;
  mainPath: string;
  /** Config file `run` was started with (`--config` or `RELAY_BACKPORT_CONFIG`). Forwarded to the agent child. */
  configPath?: string;
  exists?: (p: string) => boolean;
  readFile?: (p: string) => string;
  statSize?: (p: string) => number;
};

/**
 * Build the plan. Pure apart from the filesystem reads it names, and it never
 * reads the key's bytes — only its size — so `--dry-run` can print a plan
 * without the secret ever entering this process.
 */
export function buildPlan(opts: BuildPlanOptions): RunPlan {
  const exists = opts.exists ?? existsSync;
  const readFile = opts.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const statSize = opts.statSize ?? ((p: string) => statSync(p).size);
  const run = opts.run;

  const command = resolveBinary(run.buzzAcp, opts.env, exists);
  if (!command) throw new ConfigError(`buzz-acp not found: ${run.buzzAcp} (set run.buzz_acp or BUZZ_ACP_BIN)`);

  const sinks: SinkName[] = [...opts.sinks];
  if (opts.observe && !sinks.includes("webhook")) sinks.push("webhook");

  const self = run.self ? { command: resolve(run.self), prefixArgs: [] as string[] } : selfInvocation(opts.execPath, opts.mainPath);
  const agentArgs = [...self.prefixArgs, "acp", "--state-dir", opts.stateDir];
  for (const s of sinks) agentArgs.push("--sink", s);
  if (opts.configPath) agentArgs.push("--config", opts.configPath);

  let storeKeys: string[] = [];
  if (run.allowlistFile) {
    try {
      storeKeys = pubkeysFromStore(readFile(run.allowlistFile));
    } catch {
      throw new ConfigError(`cannot read run.allowlist_file ${run.allowlistFile}`);
    }
  }
  const allowlist = mergeAllowlist(run.allowlist, storeKeys);
  if (allowlist.length === 0) {
    throw new ConfigError("run.allowlist (or run.allowlist_file) must yield at least one 64-hex pubkey");
  }

  const env: Record<string, string> = {
    BUZZ_RELAY_URL: run.relayUrl,
    ...(run.owner ? { BUZZ_ACP_AGENT_OWNER: run.owner } : {}),
    BUZZ_ACP_RESPOND_TO: "allowlist",
    BUZZ_ACP_RESPOND_TO_ALLOWLIST: allowlist.join(","),
    BUZZ_ACP_AGENT_COMMAND: self.command,
    BUZZ_ACP_AGENT_ARGS: agentArgs.join(","),
    BUZZ_ACP_SESSION_POLICY: run.sessionPolicy,
    // Passed as env AND as flags inside BUZZ_ACP_AGENT_ARGS above, on purpose:
    // the flags win in relay-backport's own precedence, so a harness that ever
    // scrubs its child's environment still lands deliveries in the right file.
    RELAY_BACKPORT_STATE_DIR: opts.stateDir,
    RELAY_BACKPORT_SINKS: sinks.join(","),
  };
  if (opts.configPath) env.RELAY_BACKPORT_CONFIG = opts.configPath;
  if (opts.observe) env.RELAY_BACKPORT_WEBHOOK_URL = run.observeIngestUrl;

  const args = [
    "--session-title",
    run.sessionTitle,
    "--no-memory",
    "--lazy-pool",
    "--no-typing",
    "--multiple-event-handling",
    "queue",
  ];

  let keyBytes: number | undefined;
  try {
    keyBytes = statSize(run.keyFile);
  } catch {
    keyBytes = undefined;
  }

  return { command, args, env, keyFile: run.keyFile, keyBytes, sinks };
}

/** The plan as printed. The key appears as its origin and size, never its value. */
export function renderPlan(plan: RunPlan): string {
  const lines: string[] = [];
  lines.push("PLAN — exec, in this terminal's foreground:");
  lines.push("");
  lines.push(`  ${plan.command} \\`);
  lines.push(`    ${plan.args.join(" ")}`);
  lines.push("");
  lines.push("  environment for that process (and its relay-backport child) only:");
  const width = Math.max(KEY_ENV.length, ...Object.keys(plan.env).map((k) => k.length));
  lines.push(`    ${KEY_ENV.padEnd(width)} = <from ${plan.keyFile}, ${plan.keyBytes ?? "?"} bytes>   # never printed, never on a command line`);
  for (const [k, v] of Object.entries(plan.env)) lines.push(`    ${k.padEnd(width)} = ${v}`);
  lines.push("");
  lines.push(`  sinks for the relay-backport child: ${plan.sinks.join(", ")}`);
  return lines.join("\n");
}

export type PreflightOptions = {
  plan: RunPlan;
  run: RunConfig;
  stateDir: string;
  observe: boolean;
  platform?: NodeJS.Platform;
  exists?: (p: string) => boolean;
  mode?: (p: string) => number | undefined;
  writable?: (p: string) => boolean;
  /** Probe an http(s) URL; resolve true when it answered. */
  probe?: (url: string) => Promise<boolean>;
  /** Is some other process already running this session title? Undefined = could not tell. */
  duplicateSessionTitle?: (title: string) => Promise<boolean | undefined>;
};

/**
 * Everything that can be checked before the key is read. Returns the lines to
 * print; a FAIL among them means do not start.
 */
export async function preflight(opts: PreflightOptions): Promise<PreflightLine[]> {
  const out: PreflightLine[] = [];
  const exists = opts.exists ?? existsSync;
  const platform = opts.platform ?? process.platform;
  const modeOf =
    opts.mode ??
    ((p: string) => {
      try {
        return statSync(p).mode & 0o777;
      } catch {
        return undefined;
      }
    });

  out.push({ level: "OK", text: `buzz-acp: ${opts.plan.command}` });

  // ---- the key file: mode and size only; the bytes are not read here -------
  if (!exists(opts.run.keyFile)) {
    out.push({ level: "FAIL", text: `key file missing: ${opts.run.keyFile}` });
  } else if (opts.plan.keyBytes === undefined) {
    out.push({ level: "WARN", text: `key file present but unreadable by this user: ${opts.run.keyFile} — the size check is deferred to the run` });
  } else if (opts.plan.keyBytes < KEY_MIN_BYTES || opts.plan.keyBytes > KEY_MAX_BYTES) {
    out.push({
      level: "FAIL",
      text: `${opts.run.keyFile} is ${opts.plan.keyBytes} bytes; expected a 64-hex secret key or an nsec1… (${KEY_MIN_BYTES}-${KEY_MAX_BYTES})`,
    });
  } else {
    const mode = platform === "win32" ? undefined : modeOf(opts.run.keyFile);
    if (mode !== undefined && mode !== 0o600) {
      out.push({ level: "FAIL", text: `${opts.run.keyFile} mode is 0${mode.toString(8)}, expected 0600` });
    } else {
      out.push({ level: "OK", text: `key file present${mode === undefined ? "" : ", mode 0600"}, ${opts.plan.keyBytes} bytes (contents never printed)` });
    }
  }

  // ---- the allowlist ------------------------------------------------------
  const count = opts.plan.env.BUZZ_ACP_RESPOND_TO_ALLOWLIST!.split(",").length;
  out.push({ level: "OK", text: `allowlist: ${count} pubkey(s)` });

  // ---- the relay ----------------------------------------------------------
  const https = httpsFromRelay(opts.run.relayUrl);
  if (!opts.run.relayUrl) {
    out.push({ level: "FAIL", text: "no relay URL (set run.relay_url or BUZZ_RELAY_URL)" });
  } else if (!https) {
    out.push({ level: "WARN", text: `relay ${opts.run.relayUrl} cannot be probed over http(s); not checked` });
  } else if (opts.probe) {
    // A WARN, not a FAIL: buzz-acp dials and retries the websocket itself, so
    // refusing to start over one blipped HTTPS probe would be the worse bug.
    const up = await opts.probe(https);
    out.push(up ? { level: "OK", text: `relay reachable: ${opts.run.relayUrl}` } : { level: "WARN", text: `relay did not answer at ${https}; starting anyway (buzz-acp retries)` });
  }

  // ---- the state dir ------------------------------------------------------
  const canWrite =
    opts.writable ??
    ((p: string) => {
      try {
        accessSync(p, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    });
  if (exists(opts.stateDir)) {
    out.push(canWrite(opts.stateDir) ? { level: "OK", text: `state dir writable: ${opts.stateDir}` } : { level: "FAIL", text: `state dir not writable: ${opts.stateDir}` });
  } else {
    out.push({ level: "OK", text: `state dir will be created: ${opts.stateDir}` });
  }

  // ---- no second harness under the same session title ---------------------
  if (opts.duplicateSessionTitle) {
    const dup = await opts.duplicateSessionTitle(opts.run.sessionTitle);
    if (dup === true) out.push({ level: "FAIL", text: `a harness with --session-title ${opts.run.sessionTitle} is already running; stop it first` });
    else if (dup === undefined) out.push({ level: "WARN", text: `could not check for another --session-title ${opts.run.sessionTitle} harness on this platform; not checked` });
    else out.push({ level: "OK", text: `no other --session-title ${opts.run.sessionTitle} harness running` });
  }

  // ---- the observe page ---------------------------------------------------
  if (opts.observe) {
    if (!opts.probe) {
      out.push({ level: "WARN", text: `observe page at ${opts.run.observePageUrl} not checked` });
    } else {
      // GET the PAGE, not /ingest — /ingest is POST-only and answers a GET with 405.
      const up = await opts.probe(opts.run.observePageUrl);
      out.push(
        up
          ? { level: "OK", text: `observe page up at ${opts.run.observePageUrl}` }
          : { level: "FAIL", text: `observe page not up at ${opts.run.observePageUrl} (start it: relay-backport observe)` },
      );
    }
  }

  return out;
}

/** Ask the OS whether some other process already carries this session title. Undefined when it cannot be asked. */
export async function pgrepSessionTitle(title: string, platform: NodeJS.Platform = process.platform): Promise<boolean | undefined> {
  if (platform === "win32") return undefined;
  try {
    const proc = Bun.spawn(["pgrep", "-f", `buzz-acp .*--session-title ${title}`], { stdout: "pipe", stderr: "ignore" });
    const code = await proc.exited;
    if (code === 0) return true;
    if (code === 1) return false;
    return undefined;
  } catch {
    return undefined;
  }
}

export async function probeUrl(url: string, timeoutMs = 8000): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/nostr+json, text/html" } });
    return res.status < 500;
  } catch {
    return false;
  }
}

/** Read the key, register it with the log redactor, and hand it back. The one place its bytes exist. */
export function readKey(path: string, readFile: (p: string) => string = (p) => readFileSync(p, "utf8")): string {
  let key: string;
  try {
    key = readFile(path).replace(/\s+/g, "");
  } catch {
    throw new ConfigError(`cannot read ${path} (run this as the file's owner)`);
  }
  if (!key) throw new ConfigError(`${path} is empty`);
  registerSecret(key);
  return key;
}

export type RunOptions = {
  plan: RunPlan;
  run: RunConfig;
  stateDir: string;
  env: Record<string, string | undefined>;
  out: (s: string) => void;
  readFile?: (p: string) => string;
  /** Test seam: spawn the child and resolve with its exit code. */
  spawn?: (command: string, args: string[], env: Record<string, string>) => Promise<number>;
  signal?: AbortSignal;
};

/**
 * Start the harness in the foreground and wait for it. SIGINT/SIGTERM are
 * forwarded to the child rather than handled here: Ctrl-C in this terminal
 * means ears down, and the child must get the chance to close its relay
 * connection.
 */
export async function runHarness(opts: RunOptions): Promise<number> {
  mkdirSync(opts.stateDir, { recursive: true, mode: 0o700 });
  const key = readKey(opts.run.keyFile, opts.readFile);
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.env)) if (v !== undefined) childEnv[k] = v;
  Object.assign(childEnv, opts.plan.env, { [KEY_ENV]: key });

  if (opts.spawn) return opts.spawn(opts.plan.command, opts.plan.args, childEnv);

  const proc = Bun.spawn([opts.plan.command, ...opts.plan.args], {
    env: childEnv,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const forward = (sig: NodeJS.Signals) => () => {
    try {
      proc.kill(sig);
    } catch {
      // the child is already gone
    }
  };
  const onInt = forward("SIGINT");
  const onTerm = forward("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  opts.signal?.addEventListener("abort", onTerm, { once: true });
  try {
    return await proc.exited;
  } finally {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  }
}

/** Absolute, for a path that a config file may have written relative. */
export function absolute(p: string): string {
  return isAbsolute(p) ? p : resolve(p);
}
