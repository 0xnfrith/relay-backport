// Configuration: defaults < config file (TOML or JSON) < environment < CLI flags.
//
// relay-backport is spawned by a Buzz harness (Buzz Desktop, or a headless
// `buzz-acp`), which injects its own environment — `BUZZ_RELAY_URL`,
// `BUZZ_PRIVATE_KEY`, `BUZZ_AUTH_TAG`, … — so every variable of ours is
// prefixed `RELAY_BACKPORT_` and can never collide with Buzz's. Anything that
// looks like a Buzz secret is registered with the log redactor here, before
// anything else can print it, and is otherwise never read.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { registerSecret, type LogFormat } from "./log";

export const SINK_NAMES = ["file", "webhook", "exec"] as const;
export type SinkName = (typeof SINK_NAMES)[number];

export const DEFAULT_SINKS: SinkName[] = ["file"];
export const DEFAULT_FILE_NAME = "deliveries.jsonl";
export const DEFAULT_WEBHOOK_TIMEOUT_MS = 8000;
export const DEFAULT_WEBHOOK_ATTEMPTS = 3;
export const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
export const DEFAULT_DELIVERY_WAIT_MS = 15_000;
export const DEFAULT_BUZZ_ACP_BIN = "buzz-acp";
export const DEFAULT_SESSION_TITLE = "relay-backport-ears";
export const DEFAULT_SESSION_POLICY = "thread";
/** Where `--observe` expects `relay-backport observe` to be listening. */
export const DEFAULT_OBSERVE_PAGE_URL = "http://127.0.0.1:7479/";
export const DEFAULT_OBSERVE_INGEST_URL = "http://127.0.0.1:7479/ingest";

/** Environment variables Buzz injects into a harness that must never reach a log line. */
export const BUZZ_SECRET_ENV = ["BUZZ_PRIVATE_KEY", "BUZZ_ACP_PRIVATE_KEY", "NOSTR_PRIVATE_KEY", "BUZZ_API_TOKEN", "BUZZ_ACP_API_TOKEN", "BUZZ_AUTH_TAG"];

export class ConfigError extends Error {
  readonly exitCode = 1;
}

export type FileConfig = {
  path: string;
  /** Write the session/new system prompt to `<state_dir>/sessions/<id>.system-prompt.md`. Default true. */
  systemPrompt: boolean;
  /** When set, (re)write the present Buzz-injected env vars here on every session/new. Default unset (off). */
  buzzEnvFile?: string;
};

export type WebhookConfig = {
  url: string;
  bearerFile?: string;
  timeoutMs: number;
  attempts: number;
  /** Include the session/new system prompt (verbatim) in every POST. Default true. */
  includeSystemPrompt: boolean;
};

export type ExecConfig = {
  command: string[];
  timeoutMs: number;
  /** Hand the Buzz-injected `BUZZ_*` variables to the hook so it can call the `buzz` CLI. */
  passBuzzEnv: boolean;
  /** Include the session/new system prompt (verbatim) on stdin. Default false. */
  includeSystemPrompt: boolean;
};

/** `relay-backport run`: what the launcher needs to spawn `buzz-acp`. */
export type RunConfig = {
  /** The `buzz-acp` binary: a path, or a bare name looked up on PATH. */
  buzzAcp: string;
  /** The file holding the agent's private key. Its bytes go to the child's env and nowhere else. */
  keyFile: string;
  /** `BUZZ_RELAY_URL` for the child. */
  relayUrl: string;
  /** `BUZZ_ACP_AGENT_OWNER`, when there is one. */
  owner?: string;
  /** Pubkeys allowed to instruct the agent, before the store is merged in. */
  allowlist: string[];
  /** A JSON allowlist store — `{ "entries": [{ "pubkey": "…" }] }` — merged into the list. */
  allowlistFile?: string;
  sessionTitle: string;
  sessionPolicy: string;
  /** Override the path used for `BUZZ_ACP_AGENT_COMMAND` (default: this program). */
  self?: string;
  observePageUrl: string;
  observeIngestUrl: string;
};

export type Config = {
  stateDir: string;
  sinks: SinkName[];
  logFormat: LogFormat;
  /** How long a prompt turn waits for the sinks before ending anyway. */
  deliveryWaitMs: number;
  /** `BUZZ_RELAY_URL` as injected by the harness; informational, carried in payloads. */
  relayUrl: string;
  file?: FileConfig;
  webhook?: WebhookConfig;
  exec?: ExecConfig;
  run: RunConfig;
  /** Where the config file came from, for logs. */
  configPath?: string;
};

/** Everything a config file / env / flags can say, before validation. */
export type RawConfig = {
  state_dir?: string;
  sinks?: string[] | string;
  log_format?: string;
  delivery_wait_ms?: number | string;
  file?: { path?: string; system_prompt?: boolean | string; buzz_env_file?: string };
  webhook?: {
    url?: string;
    bearer_file?: string;
    timeout_ms?: number | string;
    attempts?: number | string;
    include_system_prompt?: boolean | string;
  };
  exec?: { command?: string[] | string; timeout_ms?: number | string; pass_buzz_env?: boolean | string; include_system_prompt?: boolean | string };
  run?: {
    buzz_acp?: string;
    key_file?: string;
    relay_url?: string;
    owner?: string;
    allowlist?: string[] | string;
    allowlist_file?: string;
    session_title?: string;
    session_policy?: string;
    self?: string;
    observe_page_url?: string;
    observe_ingest_url?: string;
  };
};

export type EnvMap = Record<string, string | undefined>;

export type LoadOptions = {
  configPath?: string;
  env?: EnvMap;
  /** Values from CLI flags, already in RawConfig shape. Highest precedence. */
  overrides?: RawConfig;
  readFile?: (path: string) => string;
};

function trimEnv(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

export function parseConfigText(text: string, path: string): RawConfig {
  const lower = path.toLowerCase();
  try {
    if (lower.endsWith(".json")) return JSON.parse(text) as RawConfig;
    if (lower.endsWith(".toml")) return Bun.TOML.parse(text) as RawConfig;
    try {
      return JSON.parse(text) as RawConfig;
    } catch {
      return Bun.TOML.parse(text) as RawConfig;
    }
  } catch (err) {
    throw new ConfigError(`cannot parse config ${path}: ${err instanceof Error ? err.message : "parse error"}`);
  }
}

export function rawFromEnv(env: EnvMap): RawConfig {
  const raw: RawConfig = {};
  const get = (name: string) => trimEnv(env[`RELAY_BACKPORT_${name}`]);
  const stateDir = get("STATE_DIR");
  if (stateDir) raw.state_dir = stateDir;
  const sinks = get("SINKS");
  if (sinks) raw.sinks = sinks;
  const logFormat = get("LOG_FORMAT");
  if (logFormat) raw.log_format = logFormat;
  const wait = get("DELIVERY_WAIT_MS");
  if (wait) raw.delivery_wait_ms = wait;
  const file = get("FILE");
  const fileSystemPrompt = get("FILE_SYSTEM_PROMPT");
  const fileBuzzEnvFile = get("FILE_BUZZ_ENV_FILE");
  if (file || fileSystemPrompt !== undefined || fileBuzzEnvFile) {
    raw.file = {};
    if (file) raw.file.path = file;
    if (fileSystemPrompt !== undefined) raw.file.system_prompt = fileSystemPrompt;
    if (fileBuzzEnvFile) raw.file.buzz_env_file = fileBuzzEnvFile;
  }
  const url = get("WEBHOOK_URL");
  const bearer = get("WEBHOOK_BEARER_FILE");
  const timeout = get("WEBHOOK_TIMEOUT_MS");
  const attempts = get("WEBHOOK_ATTEMPTS");
  const webhookIncludeSystemPrompt = get("WEBHOOK_INCLUDE_SYSTEM_PROMPT");
  if (url || bearer || timeout || attempts || webhookIncludeSystemPrompt !== undefined) {
    raw.webhook = {};
    if (url) raw.webhook.url = url;
    if (bearer) raw.webhook.bearer_file = bearer;
    if (timeout) raw.webhook.timeout_ms = timeout;
    if (attempts) raw.webhook.attempts = attempts;
    if (webhookIncludeSystemPrompt !== undefined) raw.webhook.include_system_prompt = webhookIncludeSystemPrompt;
  }
  const command = get("EXEC_COMMAND");
  const execTimeout = get("EXEC_TIMEOUT_MS");
  const passBuzz = get("EXEC_PASS_BUZZ_ENV");
  const execIncludeSystemPrompt = get("EXEC_INCLUDE_SYSTEM_PROMPT");
  if (command || execTimeout || passBuzz || execIncludeSystemPrompt !== undefined) {
    raw.exec = {};
    if (command) raw.exec.command = command;
    if (execTimeout) raw.exec.timeout_ms = execTimeout;
    if (passBuzz) raw.exec.pass_buzz_env = passBuzz;
    if (execIncludeSystemPrompt !== undefined) raw.exec.include_system_prompt = execIncludeSystemPrompt;
  }
  const run: NonNullable<RawConfig["run"]> = {};
  const runGet = (name: string, key: keyof NonNullable<RawConfig["run"]>) => {
    const v = get(`RUN_${name}`);
    if (v) (run as Record<string, unknown>)[key] = v;
  };
  runGet("BUZZ_ACP", "buzz_acp");
  runGet("KEY_FILE", "key_file");
  runGet("RELAY_URL", "relay_url");
  runGet("OWNER", "owner");
  runGet("ALLOWLIST", "allowlist");
  runGet("ALLOWLIST_FILE", "allowlist_file");
  runGet("SESSION_TITLE", "session_title");
  runGet("SESSION_POLICY", "session_policy");
  runGet("SELF", "self");
  runGet("OBSERVE_PAGE_URL", "observe_page_url");
  runGet("OBSERVE_INGEST_URL", "observe_ingest_url");
  if (Object.keys(run).length > 0) raw.run = run;
  return raw;
}

function mergeRaw(base: RawConfig, over: RawConfig): RawConfig {
  const out: RawConfig = { ...base, ...over };
  if (base.file || over.file) out.file = { ...(base.file ?? {}), ...(over.file ?? {}) };
  if (base.webhook || over.webhook) out.webhook = { ...(base.webhook ?? {}), ...(over.webhook ?? {}) };
  if (base.exec || over.exec) out.exec = { ...(base.exec ?? {}), ...(over.exec ?? {}) };
  if (base.run || over.run) out.run = { ...(base.run ?? {}), ...(over.run ?? {}) };
  return out;
}

function toBool(v: boolean | string | undefined, def: boolean, name: string): boolean {
  if (v === undefined) return def;
  if (typeof v === "boolean") return v;
  const s = v.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off", ""].includes(s)) return false;
  throw new ConfigError(`${name} must be true or false`);
}

function toInt(v: number | string | undefined, def: number, name: string, min = 0): number {
  if (v === undefined) return def;
  const n = typeof v === "number" ? v : Number.parseInt(String(v).trim(), 10);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) {
    throw new ConfigError(`${name} must be an integer >= ${min}`);
  }
  return n;
}

function toList(v: string[] | string | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  return v
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function toCommand(v: string[] | string | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return v.map(String).filter((s) => s.length > 0);
  return v.split(/\s+/).filter(Boolean);
}

function parseSinks(v: string[] | string | undefined): SinkName[] {
  const list = toList(v) ?? [...DEFAULT_SINKS];
  const out: SinkName[] = [];
  for (const name of list) {
    if (!(SINK_NAMES as readonly string[]).includes(name)) {
      throw new ConfigError(`unknown sink "${name}" (expected one of ${SINK_NAMES.join(", ")})`);
    }
    if (!out.includes(name as SinkName)) out.push(name as SinkName);
  }
  if (out.length === 0) throw new ConfigError("at least one sink is required");
  return out;
}

/**
 * Where deliveries live when nothing says otherwise: the platform's per-user
 * state directory. A harness is spawned with an unknown working directory,
 * so a relative default would land somewhere surprising.
 */
export function defaultStateDir(env: EnvMap, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    const base = trimEnv(env.LOCALAPPDATA) ?? join(homedir(), "AppData", "Local");
    return join(base, "relay-backport");
  }
  const base = trimEnv(env.XDG_STATE_HOME) ?? join(trimEnv(env.HOME) ?? homedir(), ".local", "state");
  return join(base, "relay-backport");
}

/**
 * Load and validate the configuration. Throws ConfigError (exit 1) on any
 * problem. Buzz-injected secrets are registered with the redactor first.
 */
export function loadConfig(opts: LoadOptions = {}): Config {
  const env = opts.env ?? process.env;
  const readFile = opts.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  for (const name of BUZZ_SECRET_ENV) registerSecret(trimEnv(env[name]));

  let raw: RawConfig = {};
  const configPath = opts.configPath ?? trimEnv(env.RELAY_BACKPORT_CONFIG);
  if (configPath) {
    let text: string;
    try {
      text = readFile(configPath);
    } catch {
      throw new ConfigError(`cannot read config file ${configPath}`);
    }
    raw = parseConfigText(text, configPath);
  }
  raw = mergeRaw(raw, rawFromEnv(env));
  if (opts.overrides) raw = mergeRaw(raw, opts.overrides);

  const stateDir = resolve(raw.state_dir ?? defaultStateDir(env));
  const logFormatRaw = (raw.log_format ?? "text").toLowerCase();
  if (logFormatRaw !== "text" && logFormatRaw !== "json") {
    throw new ConfigError('log_format must be "text" or "json"');
  }
  const sinks = parseSinks(raw.sinks);

  let file: FileConfig | undefined;
  if (sinks.includes("file")) {
    file = {
      path: resolve(raw.file?.path?.trim() || join(stateDir, DEFAULT_FILE_NAME)),
      systemPrompt: toBool(raw.file?.system_prompt, true, "file.system_prompt"),
      buzzEnvFile: raw.file?.buzz_env_file?.trim() ? resolve(raw.file.buzz_env_file.trim()) : undefined,
    };
  }

  let webhook: WebhookConfig | undefined;
  if (sinks.includes("webhook")) {
    if (!raw.webhook?.url) throw new ConfigError("webhook sink needs webhook.url (RELAY_BACKPORT_WEBHOOK_URL)");
    const url = raw.webhook.url.trim();
    if (!/^https?:\/\//.test(url)) throw new ConfigError("webhook.url must be http(s)");
    webhook = {
      url,
      bearerFile: raw.webhook.bearer_file ? resolve(raw.webhook.bearer_file) : undefined,
      timeoutMs: toInt(raw.webhook.timeout_ms, DEFAULT_WEBHOOK_TIMEOUT_MS, "webhook.timeout_ms", 1),
      attempts: toInt(raw.webhook.attempts, DEFAULT_WEBHOOK_ATTEMPTS, "webhook.attempts", 1),
      includeSystemPrompt: toBool(raw.webhook.include_system_prompt, true, "webhook.include_system_prompt"),
    };
  }

  let exec: ExecConfig | undefined;
  if (sinks.includes("exec")) {
    const command = toCommand(raw.exec?.command);
    if (!command || command.length === 0) {
      throw new ConfigError("exec sink needs exec.command (RELAY_BACKPORT_EXEC_COMMAND)");
    }
    exec = {
      command,
      timeoutMs: toInt(raw.exec?.timeout_ms, DEFAULT_EXEC_TIMEOUT_MS, "exec.timeout_ms", 1),
      passBuzzEnv: toBool(raw.exec?.pass_buzz_env, false, "exec.pass_buzz_env"),
      includeSystemPrompt: toBool(raw.exec?.include_system_prompt, false, "exec.include_system_prompt"),
    };
  }

  const runRaw = raw.run ?? {};
  const run: RunConfig = {
    // BUZZ_ACP_BIN is Buzz's own variable name, so it is read unprefixed —
    // this is the one place relay-backport reads a non-RELAY_BACKPORT_ setting
    // that is not injected by the harness.
    buzzAcp: runRaw.buzz_acp?.trim() || trimEnv(env.BUZZ_ACP_BIN) || DEFAULT_BUZZ_ACP_BIN,
    keyFile: runRaw.key_file?.trim() ? resolve(runRaw.key_file.trim()) : "",
    relayUrl: runRaw.relay_url?.trim() || trimEnv(env.BUZZ_RELAY_URL) || "",
    owner: runRaw.owner?.trim() || undefined,
    allowlist: toList(runRaw.allowlist) ?? [],
    allowlistFile: runRaw.allowlist_file?.trim() ? resolve(runRaw.allowlist_file.trim()) : undefined,
    sessionTitle: runRaw.session_title?.trim() || DEFAULT_SESSION_TITLE,
    sessionPolicy: runRaw.session_policy?.trim() || DEFAULT_SESSION_POLICY,
    self: runRaw.self?.trim() || undefined,
    observePageUrl: runRaw.observe_page_url?.trim() || DEFAULT_OBSERVE_PAGE_URL,
    observeIngestUrl: runRaw.observe_ingest_url?.trim() || DEFAULT_OBSERVE_INGEST_URL,
  };

  return {
    stateDir,
    sinks,
    logFormat: logFormatRaw as LogFormat,
    deliveryWaitMs: toInt(raw.delivery_wait_ms, DEFAULT_DELIVERY_WAIT_MS, "delivery_wait_ms", 1),
    relayUrl: trimEnv(env.BUZZ_RELAY_URL) ?? "",
    file,
    webhook,
    exec,
    run,
    configPath,
  };
}

/** A redacted, printable view of the config for startup logs. */
export function describeConfig(cfg: Config): Record<string, unknown> {
  return {
    state_dir: cfg.stateDir,
    sinks: cfg.sinks,
    delivery_wait_ms: cfg.deliveryWaitMs,
    relay: cfg.relayUrl || null,
    file: cfg.file ? { path: cfg.file.path, system_prompt: cfg.file.systemPrompt, buzz_env_file: cfg.file.buzzEnvFile ?? null } : null,
    webhook: cfg.webhook ? { url: cfg.webhook.url, bearer: Boolean(cfg.webhook.bearerFile), include_system_prompt: cfg.webhook.includeSystemPrompt } : null,
    exec: cfg.exec ? { command: cfg.exec.command, timeout_ms: cfg.exec.timeoutMs, pass_buzz_env: cfg.exec.passBuzzEnv, include_system_prompt: cfg.exec.includeSystemPrompt } : null,
    run: { buzz_acp: cfg.run.buzzAcp, key_file: cfg.run.keyFile || null, session_title: cfg.run.sessionTitle, allowlist: cfg.run.allowlist.length, allowlist_file: cfg.run.allowlistFile ?? null },
    config: cfg.configPath ?? null,
  };
}
