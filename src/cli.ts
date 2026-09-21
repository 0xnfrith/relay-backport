#!/usr/bin/env bun
// relay-backport CLI.
//
//   relay-backport [acp]   the ACP server a Buzz harness spawns (the default,
//                          so a Desktop custom-harness entry can be just the
//                          command name)
//   relay-backport run     launch buzz-acp with this program as its ACP agent
//   relay-backport tail    follow the file sink and print its lines
//   relay-backport observe  a loopback page showing what the agent sees
//
// Exit codes: 0 ok · 1 config or usage
import { lines, startAcpServer } from "./acp-server";
import { ConfigError, DEFAULT_TAIL_CURSOR_NAME, describeConfig, loadConfig, type RawConfig } from "./config";
import { configureLog, log, errMessage } from "./log";
import { DEFAULT_BIND, DEFAULT_BUFFER, DEFAULT_PORT, startObserveServer } from "./observe";
import { Receipts } from "./receipt";
import { buildSinks } from "./sinks/index";
import { buildPlan, pgrepSessionTitle, preflight, probeUrl, renderPlan, runHarness } from "./run";
import { ShowError, showDeliveries } from "./show";
import { stripThreadContext, tailFile } from "./tail";
import { NAME, VERSION } from "./version";
import { DEFAULT_VISIBLE_CHARS, MIN_VISIBLE_CHARS, projectClaudeCode } from "./view";
import { join, resolve } from "node:path";

export const HELP = `${NAME} ${VERSION}
An ACP harness that hands Buzz mentions to tools with no Buzz integration.
Buzz owns the relay; relay-backport owns delivery.

USAGE
  ${NAME} [acp] [options]     run the ACP server (what a Buzz harness spawns; the default)
  ${NAME} run [options]       launch buzz-acp with this program as its ACP agent
  ${NAME} tail [options]      follow the file sink and print its MENTION|/EVENT| lines
  ${NAME} show [options]      print one MENTION record from the local delivery file
  ${NAME} observe [options]   serve a loopback page showing what the agent sees
  ${NAME} --help | --version

OPTIONS (all commands)
  --config PATH        config file (TOML or JSON); or RELAY_BACKPORT_CONFIG
  --state-dir PATH     where the default delivery file lives; or RELAY_BACKPORT_STATE_DIR
  --file PATH          the delivery file; or RELAY_BACKPORT_FILE (default STATE_DIR/deliveries.jsonl)
  --file-content-max-chars N
                       cap the MENTION line's content; or RELAY_BACKPORT_FILE_CONTENT_MAX_CHARS
                       (default 0 = unlimited; a cap that bites adds "truncated": true)
  --file-thread-context MODE
                       none | new | cumulative (default cumulative); or
                       RELAY_BACKPORT_FILE_THREAD_CONTEXT — how much of the session's
                       thread context each MENTION line carries in thread_context
  --file-thread-context-max-chars N
                       bound the whole thread_context block (default 32000, 0 = unlimited);
                       or RELAY_BACKPORT_FILE_THREAD_CONTEXT_MAX_CHARS
  --log-format FMT     text | json (stderr; stdout is the ACP stream / the tail output)
  --verbose            debug logging

OPTIONS (acp)
  --sink NAME          file | webhook | exec (repeatable); or RELAY_BACKPORT_SINKS (default file)
  No relay URL or key: the harness that spawned this process owns them.

OPTIONS (run)
  --dry-run            preflight, print the plan with the key redacted, and exit; reads no key
  --observe            add the webhook sink and point it at the local observe page
  The key comes from run.key_file and reaches the child's ${"BUZZ_PRIVATE_KEY"} only —
  never a command line, never a log line, never the printed plan.

OPTIONS (tail)
  --cursor PATH        the line cursor (default STATE_DIR/${DEFAULT_TAIL_CURSOR_NAME}); on by default, so a
                       restart replays the lines written while the tail was down
  --no-cursor          no cursor: follow from the end of the file, as before 0.3
  --lines N            print the last N lines before following (--no-cursor only; default 0)
  --no-thread          strip thread_context from MENTION lines (for a human watching the wire)
  --no-follow          print and exit
  --view NAME          raw (default) | claude-code — a named projection of each record
  --visible-chars N    per-line budget for --view claude-code (default ${DEFAULT_VISIBLE_CHARS}, min ${MIN_VISIBLE_CHARS})
  --hide PREFIX        pubkey prefix omitted from the view's thread count (repeatable)

OPTIONS (show)
  --last               the newest MENTION record (the default)
  --id PREFIX          the MENTION whose event id starts with PREFIX; errors if ambiguous
  --hide PREFIX        pubkey prefix whose catch-up entries are omitted (repeatable)
  --raw                print the untouched record
  Reads only the local file, never the relay. A partial last line is ignored.

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

const VALUE_FLAGS = new Set([
  "config",
  "state-dir",
  "file",
  "file-content-max-chars",
  "file-thread-context",
  "file-thread-context-max-chars",
  "sink",
  "log-format",
  "lines",
  "cursor",
  "port",
  "buffer",
  "bind",
  "view",
  "visible-chars",
  "id",
  "hide",
]);
const BOOL_FLAGS = new Set(["help", "version", "verbose", "no-follow", "no-cursor", "no-thread", "dry-run", "observe", "last", "raw"]);
const REPEATABLE = new Set(["sink", "hide"]);

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
  const fileContentMax = str(flags["file-content-max-chars"]);
  const fileThreadContext = str(flags["file-thread-context"]);
  const fileThreadMax = str(flags["file-thread-context-max-chars"]);
  if (file !== undefined || fileContentMax !== undefined || fileThreadContext !== undefined || fileThreadMax !== undefined) {
    o.file = {};
    if (file !== undefined) o.file.path = file;
    if (fileContentMax !== undefined) o.file.content_max_chars = fileContentMax;
    if (fileThreadContext !== undefined) o.file.thread_context = fileThreadContext;
    if (fileThreadMax !== undefined) o.file.thread_context_max_chars = fileThreadMax;
  }
  if (Array.isArray(flags.sink)) o.sinks = flags.sink;
  const logFormat = str(flags["log-format"]);
  if (logFormat !== undefined) o.log_format = logFormat;
  const view = str(flags.view);
  const visibleChars = str(flags["visible-chars"]);
  const hide = flags.hide;
  if (view !== undefined || visibleChars !== undefined || hide !== undefined) {
    o.view = {};
    if (view !== undefined) o.view.name = view;
    if (visibleChars !== undefined) o.view.visible_chars = visibleChars;
    if (Array.isArray(hide)) o.view.hide = hide;
    else if (typeof hide === "string") o.view.hide = hide;
  }
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
        const receipts = new Receipts({
          enabled: cfg.receipt.enabled,
          reaction: cfg.receipt.reaction,
          timeoutMs: cfg.receipt.timeoutMs,
          maxSeen: cfg.receipt.maxSeen,
          stateDir: cfg.stateDir,
          relayUrl: cfg.relayUrl,
          secret: cfg.receipt.enabled ? () => io.env.BUZZ_PRIVATE_KEY : undefined,
        });
        const server = startAcpServer({
          sinks,
          write: (line) => io.out(line),
          input: lines(io.stdin ?? Bun.stdin.stream()),
          relayUrl: cfg.relayUrl,
          deliveryWaitMs: cfg.deliveryWaitMs,
          receipts,
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
      case "run": {
        const cfg = loadConfig({ configPath: str(args.flags.config), env: io.env, overrides: overridesFromFlags(args.flags) });
        configureLog({ format: cfg.logFormat, level: args.flags.verbose === true ? "debug" : "info" });
        if (!cfg.run.keyFile) throw new ConfigError("run needs run.key_file (RELAY_BACKPORT_RUN_KEY_FILE)");
        const observe = args.flags.observe === true;
        const dryRun = args.flags["dry-run"] === true;
        const plan = buildPlan({
          run: cfg.run,
          stateDir: cfg.stateDir,
          sinks: cfg.sinks,
          observe,
          env: io.env,
          execPath: process.execPath,
          mainPath: Bun.main,
          configPath: cfg.configPath,
        });
        io.out("PREFLIGHT");
        const checks = await preflight({
          plan,
          run: cfg.run,
          stateDir: cfg.stateDir,
          observe,
          probe: probeUrl,
          duplicateSessionTitle: pgrepSessionTitle,
        });
        for (const c of checks) io.out(`  ${c.level} — ${c.text}`);
        io.out("");
        io.out(renderPlan(plan));
        io.out("");
        if (checks.some((c) => c.level === "FAIL")) {
          io.err("preflight failed; nothing started");
          return 1;
        }
        if (dryRun) {
          io.out("  --dry-run: stopping here. Nothing started, no key read.");
          return 0;
        }
        io.out(`EARS UP — this terminal is the daemon. Ctrl-C stops it.`);
        return await runHarness({ plan, run: cfg.run, stateDir: cfg.stateDir, env: io.env, out: io.out, signal: io.signal });
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
        const noCursor = args.flags["no-cursor"] === true;
        const cursorFlag = str(args.flags.cursor);
        if (noCursor && cursorFlag !== undefined) throw new ConfigError("--cursor and --no-cursor cannot be combined");
        if (!noCursor && n > 0) {
          throw new ConfigError("--lines applies to --no-cursor tailing; with a cursor, the cursor decides where the tail starts");
        }
        const cursorPath = noCursor ? undefined : resolve(cursorFlag ?? join(cfg.stateDir, DEFAULT_TAIL_CURSOR_NAME));
        const noThread = args.flags["no-thread"] === true;
        const viewName = cfg.view.name;
        if (viewName !== "raw" && noThread) {
          throw new ConfigError("--view and --no-thread cannot be combined");
        }
        log.info("following", {
          path: cfg.file!.path,
          cursor: cursorPath ?? null,
          lines: n,
          thread_context: !noThread,
          view: viewName,
        });
        const titles = new Map<string, string>();
        const writeLine = (l: string) => {
          if (viewName === "claude-code") {
            // Two lines in one write so a Monitor that batches near-simultaneous
            // lines delivers the header and the text together.
            io.out(
              projectClaudeCode(l, {
                visibleChars: cfg.view.visibleChars,
                hide: cfg.view.hide,
                channels: cfg.channels,
                identities: cfg.identities,
                owner: cfg.run.owner,
                titles,
              }),
            );
            return;
          }
          io.out(noThread ? stripThreadContext(l) : l);
        };
        await tailFile({
          path: cfg.file!.path,
          // Projection happens here, in the write path: the tail still CONSUMES
          // every line (and so advances its cursor past it), it just prints a
          // different shape. One file record = one cursor step, whatever the view.
          write: writeLine,
          lines: n,
          follow: args.flags["no-follow"] !== true,
          cursorPath,
          signal: io.signal,
        });
        return 0;
      }
      case "show": {
        const cfg = loadConfig({
          configPath: str(args.flags.config),
          env: io.env,
          overrides: { ...overridesFromFlags(args.flags), sinks: ["file"] },
        });
        const last = args.flags.last === true;
        const id = str(args.flags.id);
        if (last && id !== undefined) throw new ConfigError("--last and --id cannot be combined");
        io.out(showDeliveries({ path: cfg.file!.path, id, hide: cfg.view.hide, raw: args.flags.raw === true }));
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
          let stopped = false;
          const stop = () => {
            if (stopped) return;
            stopped = true;
            process.off("SIGINT", stop);
            process.off("SIGTERM", stop);
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
