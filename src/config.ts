// Configuration: defaults < config file (TOML or JSON) < environment < CLI flags.
// Loading a config never logs a secret; key material is read here exactly once
// and registered with the redactor before anything else can print it.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parsePubkey, parseSecretKey, pubkeyOf, resolveKeyFile } from "./keys";
import { registerSecret, type LogFormat } from "./log";

export const SINK_NAMES = ["stdout", "webhook", "exec", "acp"] as const;
export type SinkName = (typeof SINK_NAMES)[number];

export const DEFAULT_CONTROL_PORT = 7477;
export const DEFAULT_REDISCOVERY_INTERVAL_S = 60;
export const DEFAULT_REPLAY_WINDOW_MAX_S = 86_400;
export const DEFAULT_KINDS = [9];
export const DEFAULT_WEBHOOK_TIMEOUT_MS = 8000;
export const DEFAULT_WEBHOOK_ATTEMPTS = 3;
export const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
export const DEFAULT_REACTION_SWEEP_S = 30 * 60;
export const DEFAULT_HEARTBEAT_S = 5;

export class ConfigError extends Error {
  readonly exitCode = 1;
}

export type WebhookConfig = {
  url: string;
  bearerFile?: string;
  timeoutMs: number;
  attempts: number;
};

export type ExecConfig = {
  command: string[];
  timeoutMs: number;
};

export type AcpConfig = {
  command: string[];
};

export type Config = {
  relayUrl: string;
  wsUrl: string;
  secretKey: Uint8Array;
  pubkey: string;
  ownerPubkey?: string;
  stateDir: string;
  sinks: SinkName[];
  mentionText?: string;
  reactions: boolean;
  reactionSweepSeconds: number;
  rediscoveryIntervalSeconds: number;
  replayWindowMaxSeconds: number;
  heartbeatSeconds: number;
  kinds: number[];
  healthPort: number;
  healthHost: string;
  controlPort: number;
  logFormat: LogFormat;
  webhook?: WebhookConfig;
  exec?: ExecConfig;
  acp?: AcpConfig;
  /** Where the config file came from, for `status` output. */
  configPath?: string;
};

/** Everything a config file / env / flags can say, before validation. */
export type RawConfig = {
  relay_url?: string;
  private_key_file?: string;
  private_key?: string;
  state_dir?: string;
  owner_pubkey?: string;
  sinks?: string[] | string;
  mention_text?: string;
  reactions?: boolean | string;
  reaction_sweep_seconds?: number | string;
  rediscovery_interval?: number | string;
  replay_window_max?: number | string;
  heartbeat_seconds?: number | string;
  kinds?: number[] | string;
  health_port?: number | string;
  health_host?: string;
  control_port?: number | string;
  log_format?: string;
  webhook?: {
    url?: string;
    bearer_file?: string;
    timeout_ms?: number | string;
    attempts?: number | string;
  };
  exec?: { command?: string[] | string; timeout_ms?: number | string };
  acp?: { command?: string[] | string };
};

export type EnvMap = Record<string, string | undefined>;

export type LoadOptions = {
  configPath?: string;
  env?: EnvMap;
  /** Values from CLI flags, already in RawConfig shape. Highest precedence. */
  overrides?: RawConfig;
  readFile?: (path: string) => string;
  /** When true, the private key is not required (CLI client commands). */
  clientOnly?: boolean;
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
    // Unknown extension: try JSON then TOML.
    try {
      return JSON.parse(text) as RawConfig;
    } catch {
      return Bun.TOML.parse(text) as RawConfig;
    }
  } catch (err) {
    throw new ConfigError(
      `cannot parse config ${path}: ${err instanceof Error ? err.message : "parse error"}`,
    );
  }
}

export function rawFromEnv(env: EnvMap): RawConfig {
  const raw: RawConfig = {};
  const set = <K extends keyof RawConfig>(key: K, value: RawConfig[K] | undefined) => {
    if (value !== undefined) raw[key] = value;
  };
  set("relay_url", trimEnv(env.RELAY_URL));
  set("private_key_file", trimEnv(env.PRIVATE_KEY_FILE));
  set("private_key", trimEnv(env.PRIVATE_KEY));
  set("state_dir", trimEnv(env.STATE_DIR));
  set("owner_pubkey", trimEnv(env.OWNER_PUBKEY));
  set("sinks", trimEnv(env.SINKS));
  set("mention_text", trimEnv(env.MENTION_TEXT));
  set("reactions", trimEnv(env.REACTIONS));
  set("reaction_sweep_seconds", trimEnv(env.REACTION_SWEEP_SECONDS));
  set("rediscovery_interval", trimEnv(env.REDISCOVERY_INTERVAL));
  set("replay_window_max", trimEnv(env.REPLAY_WINDOW_MAX));
  set("heartbeat_seconds", trimEnv(env.HEARTBEAT_SECONDS));
  set("kinds", trimEnv(env.KINDS));
  set("health_port", trimEnv(env.HEALTH_PORT));
  set("health_host", trimEnv(env.HEALTH_HOST));
  set("control_port", trimEnv(env.CONTROL_PORT));
  set("log_format", trimEnv(env.LOG_FORMAT));
  const webhookUrl = trimEnv(env.WEBHOOK_URL);
  const webhookBearer = trimEnv(env.WEBHOOK_BEARER_FILE);
  const webhookTimeout = trimEnv(env.WEBHOOK_TIMEOUT_MS);
  const webhookAttempts = trimEnv(env.WEBHOOK_ATTEMPTS);
  if (webhookUrl || webhookBearer || webhookTimeout || webhookAttempts) {
    raw.webhook = {};
    if (webhookUrl) raw.webhook.url = webhookUrl;
    if (webhookBearer) raw.webhook.bearer_file = webhookBearer;
    if (webhookTimeout) raw.webhook.timeout_ms = webhookTimeout;
    if (webhookAttempts) raw.webhook.attempts = webhookAttempts;
  }
  const execCommand = trimEnv(env.EXEC_COMMAND);
  const execTimeout = trimEnv(env.EXEC_TIMEOUT_MS);
  if (execCommand || execTimeout) {
    raw.exec = {};
    if (execCommand) raw.exec.command = execCommand;
    if (execTimeout) raw.exec.timeout_ms = execTimeout;
  }
  const acpCommand = trimEnv(env.ACP_COMMAND);
  if (acpCommand) raw.acp = { command: acpCommand };
  return raw;
}

function mergeRaw(base: RawConfig, over: RawConfig): RawConfig {
  const out: RawConfig = { ...base, ...over };
  if (base.webhook || over.webhook) out.webhook = { ...(base.webhook ?? {}), ...(over.webhook ?? {}) };
  if (base.exec || over.exec) out.exec = { ...(base.exec ?? {}), ...(over.exec ?? {}) };
  if (base.acp || over.acp) out.acp = { ...(base.acp ?? {}), ...(over.acp ?? {}) };
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

export function wsUrl(relayUrl: string): string {
  const u = relayUrl.trim().replace(/\/+$/, "");
  if (u.startsWith("https://")) return `wss://${u.slice("https://".length)}`;
  if (u.startsWith("http://")) return `ws://${u.slice("http://".length)}`;
  if (u.startsWith("ws://") || u.startsWith("wss://")) return u;
  throw new ConfigError("relay_url must start with ws://, wss://, http:// or https://");
}

function parseSinks(v: string[] | string | undefined): SinkName[] {
  const list = toList(v) ?? ["stdout"];
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
 * Load and validate the full configuration. Throws ConfigError (exit 1) on any
 * problem. The private key is read from `private_key_file` (or the inline
 * `private_key`, discouraged) and registered as a secret immediately.
 */
export function loadConfig(opts: LoadOptions = {}): Config {
  const env = opts.env ?? process.env;
  const readFile = opts.readFile ?? ((p: string) => readFileSync(p, "utf8"));

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

  const stateDir = resolve(raw.state_dir ?? "./state");
  const controlPort = toInt(raw.control_port, DEFAULT_CONTROL_PORT, "control_port");
  if (controlPort > 65535) throw new ConfigError("control_port must be <= 65535");
  const logFormatRaw = (raw.log_format ?? "text").toLowerCase();
  if (logFormatRaw !== "text" && logFormatRaw !== "json") {
    throw new ConfigError('log_format must be "text" or "json"');
  }
  const logFormat = logFormatRaw as LogFormat;

  // Client-only commands (allow/status/reload/stop) need the state dir and
  // control port; they never touch the relay key.
  if (opts.clientOnly) {
    return {
      relayUrl: raw.relay_url ?? "",
      wsUrl: "",
      secretKey: new Uint8Array(0),
      pubkey: "",
      stateDir,
      sinks: ["stdout"],
      reactions: false,
      reactionSweepSeconds: DEFAULT_REACTION_SWEEP_S,
      rediscoveryIntervalSeconds: DEFAULT_REDISCOVERY_INTERVAL_S,
      replayWindowMaxSeconds: DEFAULT_REPLAY_WINDOW_MAX_S,
      heartbeatSeconds: DEFAULT_HEARTBEAT_S,
      kinds: DEFAULT_KINDS,
      healthPort: 0,
      healthHost: "127.0.0.1",
      controlPort,
      logFormat,
      configPath,
    };
  }

  if (!raw.relay_url) throw new ConfigError("relay_url is required (RELAY_URL)");
  const relayUrl = raw.relay_url.trim();
  const socket = wsUrl(relayUrl);

  let secretKey: Uint8Array;
  if (raw.private_key) {
    registerSecret(raw.private_key);
    secretKey = parseSecretKey(raw.private_key);
  } else if (raw.private_key_file) {
    const path = resolveKeyFile(raw.private_key_file, trimEnv(env.CREDENTIALS_DIRECTORY));
    let text: string;
    try {
      text = readFile(path);
    } catch {
      throw new ConfigError(`cannot read private key file (${raw.private_key_file})`);
    }
    registerSecret(text);
    try {
      secretKey = parseSecretKey(text);
    } catch (err) {
      throw new ConfigError(
        `private key file is not a valid key: ${err instanceof Error ? err.message : "parse error"}`,
      );
    }
  } else {
    throw new ConfigError("private_key_file is required (PRIVATE_KEY_FILE)");
  }
  registerSecret(Buffer.from(secretKey).toString("hex"));
  const pubkey = pubkeyOf(secretKey);

  let ownerPubkey: string | undefined;
  if (raw.owner_pubkey) {
    try {
      ownerPubkey = parsePubkey(raw.owner_pubkey);
    } catch (err) {
      throw new ConfigError(`owner_pubkey: ${err instanceof Error ? err.message : "invalid"}`);
    }
  }

  const sinks = parseSinks(raw.sinks);
  const kindsList = toList(raw.kinds as string[] | string | undefined);
  const kinds = kindsList
    ? kindsList.map((k) => {
        const n = Number.parseInt(k, 10);
        if (!Number.isFinite(n) || n < 0) throw new ConfigError(`kinds: "${k}" is not a kind number`);
        return n;
      })
    : [...DEFAULT_KINDS];
  if (kinds.length === 0) throw new ConfigError("kinds must list at least one kind");

  const healthPort = toInt(raw.health_port, 0, "health_port");
  if (healthPort > 65535) throw new ConfigError("health_port must be <= 65535");

  const mentionText = raw.mention_text?.trim() || undefined;
  if (mentionText && !ownerPubkey) {
    throw new ConfigError("mention_text requires owner_pubkey (text mentions are owner-only)");
  }
  const reactions = toBool(raw.reactions, false, "reactions");
  if (reactions && !ownerPubkey) {
    throw new ConfigError("reactions requires owner_pubkey (reactions are owner-only)");
  }

  let webhook: WebhookConfig | undefined;
  if (sinks.includes("webhook")) {
    if (!raw.webhook?.url) throw new ConfigError("webhook sink needs webhook.url (WEBHOOK_URL)");
    const url = raw.webhook.url.trim();
    if (!/^https?:\/\//.test(url)) throw new ConfigError("webhook.url must be http(s)");
    webhook = {
      url,
      bearerFile: raw.webhook.bearer_file
        ? resolveKeyFile(raw.webhook.bearer_file, trimEnv(env.CREDENTIALS_DIRECTORY))
        : undefined,
      timeoutMs: toInt(raw.webhook.timeout_ms, DEFAULT_WEBHOOK_TIMEOUT_MS, "webhook.timeout_ms", 1),
      attempts: toInt(raw.webhook.attempts, DEFAULT_WEBHOOK_ATTEMPTS, "webhook.attempts", 1),
    };
  }

  let exec: ExecConfig | undefined;
  if (sinks.includes("exec")) {
    const command = toCommand(raw.exec?.command);
    if (!command || command.length === 0) {
      throw new ConfigError("exec sink needs exec.command (EXEC_COMMAND)");
    }
    exec = {
      command,
      timeoutMs: toInt(raw.exec?.timeout_ms, DEFAULT_EXEC_TIMEOUT_MS, "exec.timeout_ms", 1),
    };
  }

  let acp: AcpConfig | undefined;
  if (sinks.includes("acp")) {
    acp = { command: toCommand(raw.acp?.command) ?? [] };
  }

  return {
    relayUrl,
    wsUrl: socket,
    secretKey,
    pubkey,
    ownerPubkey,
    stateDir,
    sinks,
    mentionText,
    reactions,
    reactionSweepSeconds: toInt(raw.reaction_sweep_seconds, DEFAULT_REACTION_SWEEP_S, "reaction_sweep_seconds", 1),
    rediscoveryIntervalSeconds: toInt(raw.rediscovery_interval, DEFAULT_REDISCOVERY_INTERVAL_S, "rediscovery_interval", 1),
    replayWindowMaxSeconds: toInt(raw.replay_window_max, DEFAULT_REPLAY_WINDOW_MAX_S, "replay_window_max", 0),
    heartbeatSeconds: toInt(raw.heartbeat_seconds, DEFAULT_HEARTBEAT_S, "heartbeat_seconds", 1),
    kinds,
    healthPort,
    healthHost: raw.health_host?.trim() || "127.0.0.1",
    controlPort,
    logFormat,
    webhook,
    exec,
    acp,
    configPath,
  };
}

/** A redacted, printable view of the config for `status` and startup logs. */
export function describeConfig(cfg: Config): Record<string, unknown> {
  return {
    relay: cfg.relayUrl,
    pubkey: cfg.pubkey,
    owner: cfg.ownerPubkey ?? null,
    state_dir: cfg.stateDir,
    sinks: cfg.sinks,
    kinds: cfg.kinds,
    mention_text: cfg.mentionText ?? null,
    reactions: cfg.reactions,
    rediscovery_interval: cfg.rediscoveryIntervalSeconds,
    replay_window_max: cfg.replayWindowMaxSeconds,
    health: cfg.healthPort ? `${cfg.healthHost}:${cfg.healthPort}` : null,
    control_port: cfg.controlPort,
    webhook: cfg.webhook ? { url: cfg.webhook.url, bearer: Boolean(cfg.webhook.bearerFile) } : null,
    exec: cfg.exec ? { command: cfg.exec.command, timeout_ms: cfg.exec.timeoutMs } : null,
    acp: cfg.acp ? { command: cfg.acp.command } : null,
  };
}
