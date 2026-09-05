// Structured logger. Everything goes to stderr: stdout is the ACP JSON-RPC
// stream to the harness (or `tail`'s output) and must stay clean.
//
// Every string that passes through here is scrubbed against the secret
// registry, so a harness-injected key, auth tag or API token, or a webhook
// bearer, can never leak through a log line or an error message.

export type LogFormat = "text" | "json";
export type LogLevel = "debug" | "info" | "warn" | "error";

export type Fields = Record<string, unknown>;

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const secrets = new Set<string>();
let format: LogFormat = "text";
let minLevel: LogLevel = "info";
let writer: (line: string) => void = (line) => {
  process.stderr.write(line + "\n");
};

export function configureLog(opts: {
  format?: LogFormat;
  level?: LogLevel;
  writer?: (line: string) => void;
}): void {
  if (opts.format) format = opts.format;
  if (opts.level) minLevel = opts.level;
  if (opts.writer) writer = opts.writer;
}

/** Register a secret so it is masked wherever it appears in log output. */
export function registerSecret(secret: string | undefined | null): void {
  if (!secret) return;
  const s = secret.trim();
  if (s.length >= 8) secrets.add(s);
}

export function clearSecrets(): void {
  secrets.clear();
}

export function redact(text: string): string {
  let out = text;
  for (const s of secrets) {
    if (out.includes(s)) out = out.split(s).join("[redacted]");
  }
  return out;
}

function redactValue(v: unknown): unknown {
  if (typeof v === "string") return redact(v);
  if (v instanceof Error) return redact(v.message);
  if (Array.isArray(v)) return v.map(redactValue);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = redactValue(val);
    return o;
  }
  return v;
}

function emit(level: LogLevel, msg: string, fields?: Fields): void {
  if (LEVELS[level] < LEVELS[minLevel]) return;
  const ts = new Date().toISOString();
  const safeMsg = redact(msg);
  const safeFields = fields ? (redactValue(fields) as Fields) : undefined;
  if (format === "json") {
    writer(JSON.stringify({ ts, level, msg: safeMsg, ...(safeFields ?? {}) }));
    return;
  }
  let line = `${ts} ${level.padEnd(5)} ${safeMsg}`;
  if (safeFields) {
    for (const [k, v] of Object.entries(safeFields)) {
      const rendered = typeof v === "string" ? v : JSON.stringify(v);
      line += ` ${k}=${rendered}`;
    }
  }
  writer(line);
}

export const log = {
  debug: (msg: string, fields?: Fields) => emit("debug", msg, fields),
  info: (msg: string, fields?: Fields) => emit("info", msg, fields),
  warn: (msg: string, fields?: Fields) => emit("warn", msg, fields),
  error: (msg: string, fields?: Fields) => emit("error", msg, fields),
};

/** Error message safe to print: redacted, never the raw stack. */
export function errMessage(err: unknown): string {
  if (err instanceof Error) return redact(err.message);
  if (typeof err === "string") return redact(err);
  return "error";
}
