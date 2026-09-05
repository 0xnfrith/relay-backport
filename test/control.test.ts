import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { ControlClientError, controlRequest, secretsMatch, startControlServer, type ControlRequest } from "../src/control";
import { configureLog } from "../src/log";

configureLog({ writer: () => {} });

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function server(handler?: (req: ControlRequest) => Promise<unknown>) {
  const secret = randomBytes(32).toString("hex");
  const seen: ControlRequest[] = [];
  const srv = startControlServer({
    port: 0,
    secret,
    handler: async (req) => {
      seen.push(req);
      return { ok: true, result: handler ? await handler(req) : { echo: req.cmd } };
    },
  });
  cleanups.push(srv.stop);
  return { ...srv, secret, seen };
}

describe("control channel", () => {
  test("a request with the right secret is answered", async () => {
    const s = server();
    const res = await controlRequest({ port: s.port, secret: s.secret }, { cmd: "status" });
    expect(res).toEqual({ ok: true, result: { echo: "status" } });
    expect(s.seen[0]?.cmd).toBe("status");
  });

  test("a wrong secret is refused and the handler never runs", async () => {
    const s = server();
    const res = await controlRequest({ port: s.port, secret: "x".repeat(64) }, { cmd: "stop" });
    expect(res).toEqual({ ok: false, error: "unauthorized", code: "unauthorized" });
    expect(s.seen.length).toBe(0);
  });

  test("an empty secret never matches, even against an empty secret", () => {
    expect(secretsMatch("", "")).toBe(false);
    expect(secretsMatch("abc", "abd")).toBe(false);
    expect(secretsMatch("abc", "abc")).toBe(true);
  });

  test("unknown commands and invalid JSON are bad requests", async () => {
    const s = server();
    const res = await controlRequest({ port: s.port, secret: s.secret }, { cmd: "nuke" as ControlRequest["cmd"] });
    expect(res.ok).toBe(false);
    expect((res as { code?: string }).code).toBe("bad_request");
    // raw invalid line
    const raw = await new Promise<string>((resolve, reject) => {
      let buf = "";
      Bun.connect({
        hostname: "127.0.0.1",
        port: s.port,
        socket: {
          open(sock) {
            sock.write("this is not json\n");
          },
          data(_sock, chunk) {
            buf += Buffer.from(chunk).toString();
            if (buf.includes("\n")) resolve(buf.trim());
          },
          error: (_s, e) => reject(e),
          close: () => resolve(buf.trim()),
        },
      });
    });
    expect(JSON.parse(raw)).toEqual({ ok: false, error: "invalid json", code: "bad_request" });
  });

  test("arguments (pubkey, mode, note) travel through", async () => {
    const s = server(async (req) => req);
    const res = await controlRequest(
      { port: s.port, secret: s.secret },
      { cmd: "allow.add", pubkey: "ab", mode: "any", note: "hello world" },
    );
    expect(res).toEqual({ ok: true, result: { cmd: "allow.add", pubkey: "ab", mode: "any", note: "hello world" } });
  });

  test("nothing listening → ControlClientError (exit 4)", async () => {
    let err: unknown;
    try {
      await controlRequest({ port: 1, secret: "s".repeat(64), timeoutMs: 1500 }, { cmd: "status" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ControlClientError);
    expect((err as ControlClientError).exitCode).toBe(4);
  });
});
