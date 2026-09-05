#!/usr/bin/env bun
// relay-backport CLI.
//
// Exit codes: 0 ok · 1 config/state · 2 relay network · 3 relay auth · 4 control refused
import { ConfigError, loadConfig, type RawConfig } from "./config";
import { controlRequest, ControlClientError, type ControlRequest, type ControlResponse } from "./control";
import { startDaemon } from "./daemon";
import { configureLog, log, errMessage } from "./log";
import { readControlFiles, statePaths, StateError } from "./state";
import { NAME, VERSION } from "./version";

export const HELP = `${NAME} ${VERSION}
Ears on a Buzz relay for agents that have no official Buzz integration.

USAGE
  ${NAME} watch [options]                 run the daemon
  ${NAME} status                          show a running daemon's state
  ${NAME} allow add <pubkey> [--mode ptag|any] [--note TEXT]
  ${NAME} allow remove <pubkey>
  ${NAME} allow list
  ${NAME} reload                          re-read the config file (sinks, kinds, mention text)
  ${NAME} stop                            stop the running daemon
  ${NAME} --help | --version

OPTIONS (all commands)
  --config PATH        config file (TOML or JSON); or RELAY_BACKPORT_CONFIG
  --state-dir PATH     state directory; or STATE_DIR (default ./state)
  --control-port N     control channel port; or CONTROL_PORT
  --json               machine-readable output for status / allow list

OPTIONS (watch)
  --relay URL          relay URL; or RELAY_URL
  --key-file PATH      private key file; or PRIVATE_KEY_FILE
  --owner PUBKEY       owner pubkey (hex or npub); or OWNER_PUBKEY
  --sink NAME          stdout | webhook | exec | acp (repeatable); or SINKS
  --mention-text TEXT  also match this literal text in owner messages
  --reactions          react on owner mentions (seen/working)
  --kinds LIST         message kinds to watch (default 9)
  --health-port N      health endpoint port (0 = off)
  --log-format FMT     text | json
  --reset-allowlist    archive an unverifiable allowlist and start empty
  --retry-connect      keep retrying if the first relay connection fails

EXIT CODES
  0 ok · 1 config or state · 2 relay network · 3 relay auth · 4 control refused
`;

export type ParsedArgs = {
  command: string | undefined;
  positional: string[];
  flags: Record<string, string | boolean | string[]>;
};

const VALUE_FLAGS = new Set([
  "config",
  "state-dir",
  "control-port",
  "relay",
  "key-file",
  "owner",
  "sink",
  "mention-text",
  "kinds",
  "health-port",
  "log-format",
  "mode",
  "note",
]);
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
      } else {
        if (value !== undefined) throw new ConfigError(`--${name} does not take a value`);
        flags[name] = true;
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
  const set = <K extends keyof RawConfig>(k: K, v: RawConfig[K] | undefined) => {
    if (v !== undefined) o[k] = v;
  };
  set("state_dir", str(flags["state-dir"]));
  set("control_port", str(flags["control-port"]));
  set("relay_url", str(flags.relay));
  set("private_key_file", str(flags["key-file"]));
  set("owner_pubkey", str(flags.owner));
  if (Array.isArray(flags.sink)) o.sinks = flags.sink;
  set("mention_text", str(flags["mention-text"]));
  if (flags.reactions === true) o.reactions = true;
  set("kinds", str(flags.kinds));
  set("health_port", str(flags["health-port"]));
  set("log_format", str(flags["log-format"]));
  return o;
}

type Io = {
  out: (s: string) => void;
  err: (s: string) => void;
  env: Record<string, string | undefined>;
};

async function clientCommand(args: ParsedArgs, io: Io, req: ControlRequest): Promise<ControlResponse> {
  const cfg = loadConfig({
    configPath: str(args.flags.config),
    env: io.env,
    overrides: overridesFromFlags(args.flags),
    clientOnly: true,
  });
  const paths = statePaths(cfg.stateDir);
  const files = readControlFiles(paths);
  if (!files) {
    throw new ControlClientError(
      `no running daemon found (missing ${paths.controlSecret}); is the daemon running with this state dir?`,
    );
  }
  const port = str(args.flags["control-port"]) ? cfg.controlPort : files.port;
  const res = await controlRequest({ port, secret: files.secret }, req);
  if (!res.ok && res.code === "unauthorized") throw new ControlClientError("daemon refused the control secret");
  return res;
}

function printStatus(result: Record<string, unknown>, io: Io, json: boolean): void {
  if (json) {
    io.out(JSON.stringify(result, null, 2));
    return;
  }
  const c = result.counters as Record<string, number>;
  const a = result.allowlist as { owner: string | null; entries: number; refused: unknown[] };
  const r = result.reactions as { enabled: boolean; pending: number };
  const lines = [
    `${NAME} ${result.version}`,
    `relay        ${result.relay}`,
    `pubkey       ${result.pubkey}`,
    `connected    ${result.connected} (authed: ${result.authed})`,
    `uptime       ${result.uptime_s}s`,
    `channels     ${result.channels}`,
    `sinks        ${(result.sinks as string[]).join(", ")}`,
    `owner        ${a.owner ?? "(none)"}`,
    `allowlist    ${a.entries} entr${a.entries === 1 ? "y" : "ies"}, ${a.refused.length} refused`,
    `reactions    ${r.enabled ? `on, ${r.pending} pending` : "off"}`,
    `control      127.0.0.1:${result.control_port}`,
    `counters     received=${c.received} mentions=${c.mentions} delivered=${c.delivered} failed=${c.delivery_failed}`,
    `             dropped: not_allowed=${c.dropped_not_allowed} self=${c.dropped_self} duplicate=${c.dropped_duplicate} kind=${c.dropped_kind}`,
  ];
  io.out(lines.join("\n"));
}

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
  if (args.flags.help || !args.command) {
    io.out(HELP.trimEnd());
    return args.command ? 0 : args.flags.help ? 0 : 1;
  }
  const json = args.flags.json === true;

  try {
    switch (args.command) {
      case "watch": {
        const loadOptions = {
          configPath: str(args.flags.config),
          env: io.env,
          overrides: overridesFromFlags(args.flags),
        };
        const cfg = loadConfig(loadOptions);
        configureLog({ format: cfg.logFormat, level: args.flags.verbose === true ? "debug" : "info" });
        log.info("starting", { version: VERSION, relay: cfg.relayUrl, pubkey: cfg.pubkey, sinks: cfg.sinks });
        const daemon = await startDaemon(cfg, {
          resetAllowlist: args.flags["reset-allowlist"] === true,
          loadOptions,
          exitOnFirstConnectFailure: args.flags["retry-connect"] !== true,
        });
        let signalled = false;
        const onSignal = () => {
          if (signalled) process.exit(130);
          signalled = true;
          log.info("signal received, stopping");
          void daemon.stop(0);
        };
        process.on("SIGINT", onSignal);
        process.on("SIGTERM", onSignal);
        return await daemon.exited;
      }
      case "status": {
        const res = await clientCommand(args, io, { cmd: "status" });
        if (!res.ok) throw new ControlClientError(res.error);
        printStatus(res.result as Record<string, unknown>, io, json);
        return 0;
      }
      case "allow": {
        const sub = args.positional[0];
        if (sub === "add") {
          const pubkey = args.positional[1];
          if (!pubkey) throw new ConfigError("allow add needs a pubkey");
          const res = await clientCommand(args, io, {
            cmd: "allow.add",
            pubkey,
            mode: str(args.flags.mode) ?? "ptag",
            note: str(args.flags.note),
          });
          if (!res.ok) throw new ControlClientError(res.error);
          const e = res.result as { pubkey: string; mode: string; note?: string };
          io.out(json ? JSON.stringify(e) : `allowed ${e.pubkey} mode=${e.mode}${e.note ? ` note=${JSON.stringify(e.note)}` : ""}`);
          return 0;
        }
        if (sub === "remove") {
          const pubkey = args.positional[1];
          if (!pubkey) throw new ConfigError("allow remove needs a pubkey");
          const res = await clientCommand(args, io, { cmd: "allow.remove", pubkey });
          if (!res.ok) throw new ControlClientError(res.error);
          const r = res.result as { removed: boolean; pubkey: string };
          io.out(json ? JSON.stringify(r) : r.removed ? `removed ${r.pubkey}` : `not listed: ${r.pubkey}`);
          return 0;
        }
        if (sub === "list") {
          const res = await clientCommand(args, io, { cmd: "allow.list" });
          if (!res.ok) throw new ControlClientError(res.error);
          const r = res.result as {
            owner: string | null;
            entries: { pubkey: string; mode: string; note?: string; added_at: number }[];
            refused: { pubkey: string; reason: string }[];
          };
          if (json) {
            io.out(JSON.stringify(r, null, 2));
            return 0;
          }
          const lines = [`owner  ${r.owner ?? "(none)"}  (always allowed)`];
          if (r.entries.length === 0) lines.push("(no allowlist entries)");
          for (const e of r.entries) {
            lines.push(
              `${e.pubkey}  ${e.mode.padEnd(4)}  ${new Date(e.added_at * 1000).toISOString()}${e.note ? `  ${e.note}` : ""}`,
            );
          }
          for (const x of r.refused) lines.push(`REFUSED ${x.pubkey}  ${x.reason}`);
          io.out(lines.join("\n"));
          return 0;
        }
        throw new ConfigError("allow needs add | remove | list");
      }
      case "reload": {
        const res = await clientCommand(args, io, { cmd: "reload" });
        if (!res.ok) throw new ControlClientError(res.error);
        io.out(json ? JSON.stringify(res.result) : `reloaded: ${JSON.stringify(res.result)}`);
        return 0;
      }
      case "stop": {
        const res = await clientCommand(args, io, { cmd: "stop" });
        if (!res.ok) throw new ControlClientError(res.error);
        io.out(json ? JSON.stringify(res.result) : "stopping");
        return 0;
      }
      default:
        io.err(`unknown command "${args.command}"`);
        io.err(`run '${NAME} --help' for usage`);
        return 1;
    }
  } catch (err) {
    io.err(errMessage(err));
    if (err instanceof ConfigError || err instanceof StateError) return 1;
    if (err instanceof ControlClientError) return 4;
    const code = (err as { exitCode?: number } | null)?.exitCode;
    return typeof code === "number" ? code : 1;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(errMessage(err));
      process.exit(1);
    },
  );
}
