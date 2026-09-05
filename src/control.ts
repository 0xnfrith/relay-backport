// Control channel: loopback TCP, newline-delimited JSON, authenticated by a
// per-run secret the daemon writes to STATE_DIR/control.secret (0600).
// Loopback TCP rather than a Unix socket so Linux, macOS and Windows behave
// identically. The CLI is a pure client: it never touches the state files.
import { timingSafeEqual } from "node:crypto";
import type { Socket } from "bun";
import { log } from "./log";

export const CONTROL_COMMANDS = ["allow.add", "allow.remove", "allow.list", "status", "reload", "stop"] as const;
export type ControlCommand = (typeof CONTROL_COMMANDS)[number];

export type ControlRequest = {
  cmd: ControlCommand;
  pubkey?: string;
  mode?: string;
  note?: string;
};

export type ControlResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: string; code?: "unauthorized" | "bad_request" | "failed" };

export type ControlHandler = (req: ControlRequest) => Promise<ControlResponse>;

const MAX_LINE = 64 * 1024;

export function secretsMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length || ba.length === 0) return false;
  return timingSafeEqual(ba, bb);
}

export function isControlCommand(v: unknown): v is ControlCommand {
  return typeof v === "string" && (CONTROL_COMMANDS as readonly string[]).includes(v);
}

type ConnState = { buf: string };

export function startControlServer(opts: {
  port: number;
  secret: string;
  handler: ControlHandler;
  hostname?: string;
}): { port: number; stop: () => void } {
  const hostname = opts.hostname ?? "127.0.0.1";
  const server = Bun.listen<ConnState>({
    hostname,
    port: opts.port,
    socket: {
      open(socket) {
        socket.data = { buf: "" };
      },
      data(socket, chunk) {
        const state = socket.data;
        state.buf += Buffer.from(chunk).toString("utf8");
        if (state.buf.length > MAX_LINE) {
          reply(socket, { ok: false, error: "request too large", code: "bad_request" });
          socket.end();
          return;
        }
        let nl = state.buf.indexOf("\n");
        while (nl >= 0) {
          const line = state.buf.slice(0, nl).trim();
          state.buf = state.buf.slice(nl + 1);
          if (line) void handleLine(socket, line, opts.secret, opts.handler);
          nl = state.buf.indexOf("\n");
        }
      },
      error(_socket, err) {
        log.debug("control socket error", { error: err.message });
      },
      close() {
        // nothing to clean
      },
    },
  });
  return {
    port: server.port,
    stop: () => server.stop(true),
  };
}

function reply(socket: Socket<ConnState>, res: ControlResponse): void {
  try {
    socket.write(JSON.stringify(res) + "\n");
  } catch {
    // client gone
  }
}

async function handleLine(
  socket: Socket<ConnState>,
  line: string,
  secret: string,
  handler: ControlHandler,
): Promise<void> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    reply(socket, { ok: false, error: "invalid json", code: "bad_request" });
    socket.end();
    return;
  }
  const given = typeof parsed.secret === "string" ? parsed.secret : "";
  if (!secretsMatch(given, secret)) {
    log.warn("control request refused: bad secret");
    reply(socket, { ok: false, error: "unauthorized", code: "unauthorized" });
    socket.end();
    return;
  }
  if (!isControlCommand(parsed.cmd)) {
    reply(socket, { ok: false, error: "unknown command", code: "bad_request" });
    return;
  }
  const req: ControlRequest = {
    cmd: parsed.cmd,
    pubkey: typeof parsed.pubkey === "string" ? parsed.pubkey : undefined,
    mode: typeof parsed.mode === "string" ? parsed.mode : undefined,
    note: typeof parsed.note === "string" ? parsed.note : undefined,
  };
  try {
    reply(socket, await handler(req));
  } catch (err) {
    reply(socket, { ok: false, error: err instanceof Error ? err.message : "failed", code: "failed" });
  }
}

export class ControlClientError extends Error {
  readonly exitCode = 4;
}

/** Send one request and wait for its one-line reply. */
export function controlRequest(
  opts: { port: number; secret: string; hostname?: string; timeoutMs?: number },
  req: ControlRequest,
): Promise<ControlResponse> {
  return new Promise((resolve, reject) => {
    let buf = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new ControlClientError("control request timed out")));
    }, opts.timeoutMs ?? 5000);

    Bun.connect({
      hostname: opts.hostname ?? "127.0.0.1",
      port: opts.port,
      socket: {
        open(socket) {
          socket.write(JSON.stringify({ secret: opts.secret, ...req }) + "\n");
        },
        data(socket, chunk) {
          buf += Buffer.from(chunk).toString("utf8");
          const nl = buf.indexOf("\n");
          if (nl < 0) return;
          const line = buf.slice(0, nl);
          finish(() => {
            try {
              resolve(JSON.parse(line) as ControlResponse);
            } catch {
              reject(new ControlClientError("malformed reply from daemon"));
            }
          });
          socket.end();
        },
        close() {
          finish(() => reject(new ControlClientError("daemon closed the connection")));
        },
        error(_socket, err) {
          finish(() => reject(new ControlClientError(`control connection failed: ${err.message}`)));
        },
        connectError(_socket, err) {
          finish(() => reject(new ControlClientError(`cannot reach daemon: ${err.message}`)));
        },
      },
    }).catch((err: unknown) => {
      finish(() =>
        reject(new ControlClientError(`cannot reach daemon: ${err instanceof Error ? err.message : "error"}`)),
      );
    });
  });
}
