#!/usr/bin/env bun
// relay-backport CLI.
//
//   relay-backport [acp]   the ACP server a Buzz harness spawns (the default,
//                          so a Desktop custom-harness entry can be just the
//                          command name)
//   relay-backport tail    follow the file sink and print its lines
//   relay-backport observe  a loopback page showing what the agent sees
//
// Exit codes: 0 ok · 1 config or usage
import { lines, startAcpServer } from "./acp-server";
import { ConfigError, describeConfig, loadConfig, type RawConfig } from "./config";
import { configureLog, log, errMessage } from "./log";
import { DEFAULT_BIND, DEFAULT_BUFFER, DEFAULT_PORT, startObserveServer } from "./observe";
import { buildSinks } from "./sinks/index";
import { tailFile } from "./tail";
import { NAME, VERSION } from "./version";

export const HELP = `${NAME} ${VERSION}
An ACP harness that hands Buzz mentions to tools with no Buzz integration.
Buzz owns the relay; relay-backport owns delivery.

USAGE
  ${NAME} [acp] [options]     run the ACP server (what a Buzz harness spawns; the default)
  ${NAME} tail [options]      follow the file sink and print its MENTION|/EVENT| lines
  ${NAME} observe [options]   serve a loopback page showing what the agent sees
  ${NAME} --help | --version

OPTIONS (all commands)
  --config PATH        config file (TOML or JSON); or RELAY_BACKPORT_CONFIG
  --state-dir PATH     where the default delivery file lives; or RELAY_BACKPORT_STATE_DIR
  --file PATH          the delivery file; or RELAY_BACKPORT_FILE (default STATE_DIR/deliveries.jsonl)
  --log-format FMT     text | json (stderr; stdout is the ACP stream / the tail output)
  --verbose            debug logging

OPTIONS (acp)
  --sink NAME          file | webhook | exec (repeatable); or RELAY_BACKPORT_SINKS (default file)
  No relay URL or key: the harness that spawned this process owns them.

OPTIONS (tail)
  --lines N            print the last N lines before following (default 0)
  --no-follow          print and exit

OPTIONS (observe)
  --port N             listen on this port (default ${DEFAULT_PORT}; 0 picks a free one)
  --buffer N           deliveries kept for replay (default ${DEFAULT_BUFFER})
  --bind ADDR          interface to bind (default ${DEFAULT_BIND}; loopback, no auth)
  Feed it with the webhook sink: RELAY_BACKPORT_SINKS=file,webhook
  RELAY_BACKPORT_WEBHOOK_URL=http://${DEFAULT_BIND}:${DEFAULT_PORT}/ingest

EXIT CODES
  0 ok · 1 config or usage
`;

export type ParsedArgs = {
  command: string | undefined;
  positional: string[];
  flags: Record<string, string | boolean | string[]>;
};

const VALUE_FLAGS = new Set(["config", "state-dir", "file", "sink", "log-format", "lines", "port", "buffer", "bind"]);
const BOOL_FLAGS = new Set(["help", "version", "verbose", "no-follow"]);
const REPEATABLE = new Set(["sink"]);

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean | string[]> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      let name = a.slice(2);
      let value: string | undefined;
      const eq = name.indexOf("=");
      if (eq >= 0) {
        value = name.slice(eq + 1);
        name = name.slice(0, eq);
      }
      if (VALUE_FLAGS.has(name)) {
        if (value === undefined) {
          value = argv[i + 1];
          if (value === undefined || value.startsWith("--")) throw new ConfigError(`--${name} needs a value`);
          i++;
        }
        if (REPEATABLE.has(name)) {
          const cur = flags[name];
          flags[name] = Array.isArray(cur) ? [...cur, value] : [value];
        } else {
          flags[name] = value;
        }
      } else if (BOOL_FLAGS.has(name)) {
        if (value !== undefined) throw new ConfigError(`--${name} does not take a value`);
        flags[name] = true;
      } else {
        throw new ConfigError(`unknown option --${name}`);
      }
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      if (a === "-h") flags.help = true;
      else if (a === "-v") flags.version = true;
      else throw new ConfigError(`unknown option ${a}`);
      continue;
    }
    positional.push(a);
  }
  return { command: positional[0], positional: positional.slice(1), flags };
}

function str(v: string | boolean | string[] | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Parse an integer flag, or throw a usage error naming it. */
export function intFlag(raw: string | undefined, fallback: number, name: string, min: number): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min) throw new ConfigError(`${name} must be an integer >= ${min}`);
  return n;
}

export function overridesFromFlags(flags: ParsedArgs["flags"]): RawConfig {
  const o: RawConfig = {};
  const stateDir = str(flags["state-dir"]);
  if (stateDir !== undefined) o.state_dir = stateDir;
  const file = str(flags.file);
  if (file !== undefined) o.file = { path: file };
  if (Array.isArray(flags.sink)) o.sinks = flags.sink;
  const logFormat = str(flags["log-format"]);
  if (logFormat !== undefined) o.log_format = logFormat;
  return o;
}

type Io = {
  out: (s: string) => void;
  err: (s: string) => void;
  env: Record<string, string | undefined>;
  /** Test seams. */
  stdin?: ReadableStream<Uint8Array>;
  signal?: AbortSignal;
};

/** Run the CLI; resolves with the exit code. */
export async function main(argv: string[], io: Io = { out: console.log, err: console.error, env: process.env }): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    io.err(errMessage(err));
    io.err(`run '${NAME} --help' for usage`);
    return 1;
  }
  if (args.flags.version) {
    io.out(`${NAME} ${VERSION}`);
    return 0;
  }
  if (args.flags.help) {
    io.out(HELP.trimEnd());
    return 0;
  }
  const command = args.command ?? "acp";

  try {
    switch (command) {
      case "acp": {
        const cfg = loadConfig({ configPath: str(args.flags.config), env: io.env, overrides: overridesFromFlags(args.flags) });
        configureLog({ format: cfg.logFormat, level: args.flags.verbose === true ? "debug" : "info" });
        log.info("starting acp server", { version: VERSION, ...describeConfig(cfg) });
        const sinks = buildSinks(cfg, { env: io.env });
        const server = startAcpServer({
          sinks,
          write: (line) => io.out(line),
          input: lines(io.stdin ?? Bun.stdin.stream()),
          relayUrl: cfg.relayUrl,
          deliveryWaitMs: cfg.deliveryWaitMs,
        });
        const onSignal = () => {
          log.info("signal received, stopping acp server");
          process.exit(0);
        };
        process.on("SIGINT", onSignal);
        process.on("SIGTERM", onSignal);
        await server.done;
        for (const s of sinks) await s.close?.();
        return 0;
      }
      case "tail": {
        const cfg = loadConfig({
          configPath: str(args.flags.config),
          env: io.env,
          overrides: { ...overridesFromFlags(args.flags), sinks: ["file"] },
        });
        configureLog({ format: cfg.logFormat, level: args.flags.verbose === true ? "debug" : "info" });
        const n = Number.parseInt(str(args.flags.lines) ?? "0", 10);
        if (!Number.isFinite(n) || n < 0) throw new ConfigError("--lines must be an integer >= 0");
        log.info("following", { path: cfg.file!.path, lines: n });
        await tailFile({ path: cfg.file!.path, write: (l) => io.out(l), lines: n, follow: args.flags["no-follow"] !== true, signal: io.signal });
        return 0;
      }
      case "observe": {
        configureLog({ format: str(args.flags["log-format"]) === "json" ? "json" : "text", level: args.flags.verbose === true ? "debug" : "info" });
        const port = intFlag(str(args.flags.port), DEFAULT_PORT, "--port", 0);
        const buffer = intFlag(str(args.flags.buffer), DEFAULT_BUFFER, "--buffer", 1);
        const host = str(args.flags.bind) ?? DEFAULT_BIND;
        const server = startObserveServer({ host, port, buffer });
        io.out(`${NAME} observe on http://${host}:${server.port}/ — POST deliveries to http://${host}:${server.port}/ingest`);
        await new Promise<void>((resolve) => {
          const stop = () => {
            server.stop();
            resolve();
          };
          if (io.signal) {
            if (io.signal.aborted) return stop();
            io.signal.addEventListener("abort", stop, { once: true });
          }
          process.on("SIGINT", stop);
          process.on("SIGTERM", stop);
        });
        return 0;
      }
      default:
        io.err(`unknown command "${command}"`);
        io.err(`run '${NAME} --help' for usage`);
        return 1;
    }
  } catch (err) {
    io.err(errMessage(err));
    return 1;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2), {
    out: (s) => void process.stdout.write(s + "\n"),
    err: (s) => void process.stderr.write(s + "\n"),
    env: process.env,
  }).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(errMessage(err) + "\n");
      process.exit(1);
    },
  );
}
