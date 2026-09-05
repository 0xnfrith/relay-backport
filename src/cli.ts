#!/usr/bin/env bun
// relay-backport CLI.
//
//   relay-backport [acp]   the ACP server a Buzz harness spawns (the default,
//                          so a Desktop custom-harness entry can be just the
//                          command name)
//   relay-backport tail    follow the file sink and print its lines
//
// Exit codes: 0 ok · 1 config or usage
import { lines, startAcpServer } from "./acp-server";
import { ConfigError, describeConfig, loadConfig, type RawConfig } from "./config";
import { configureLog, log, errMessage } from "./log";
import { buildSinks } from "./sinks/index";
import { tailFile } from "./tail";
import { NAME, VERSION } from "./version";

export const HELP = `${NAME} ${VERSION}
An ACP harness that hands Buzz mentions to tools with no Buzz integration.
Buzz owns the relay; relay-backport owns delivery.

USAGE
  ${NAME} [acp] [options]     run the ACP server (what a Buzz harness spawns; the default)
  ${NAME} tail [options]      follow the file sink and print its MENTION|/EVENT| lines
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

EXIT CODES
  0 ok · 1 config or usage
`;

export type ParsedArgs = {
  command: string | undefined;
  positional: string[];
  flags: Record<string, string | boolean | string[]>;
};

const VALUE_FLAGS = new Set(["config", "state-dir", "file", "sink", "log-format", "lines"]);
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
