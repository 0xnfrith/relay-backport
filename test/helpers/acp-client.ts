// An in-process ACP client that drives `relay-backport acp` the way a Buzz
// harness does: spawn the CLI, NDJSON over stdio, requests with ids,
// notifications without.
import { join } from "node:path";

export const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");

export type JsonRpcResponse = { id?: unknown; result?: unknown; error?: { code: number; message: string } };

export type AcpClient = {
  send: (msg: Record<string, unknown>) => void;
  request: (method: string, params: unknown) => Promise<JsonRpcResponse>;
  waitFor: (pred: (line: string) => boolean, label: string, timeoutMs?: number) => Promise<string>;
  /** Every stdout line so far. */
  lines: string[];
  /** Parsed `session/update` notifications so far. */
  updates: () => { sessionId?: string; update?: { sessionUpdate?: string; content?: { text?: string } } }[];
  stderr: () => Promise<string>;
  /** Close stdin and wait for the process to exit. */
  close: () => Promise<number>;
  kill: () => void;
};

export function spawnAcp(args: string[], env: Record<string, string>, bin: string[] = [process.execPath, CLI]): AcpClient {
  const proc = Bun.spawn([...bin, ...args], {
    env: { ...process.env, ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const lines: string[] = [];
  const waiters: { pred: (l: string) => boolean; resolve: (l: string) => void }[] = [];
  void (async () => {
    const reader = proc.stdout.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        lines.push(line);
        for (const w of [...waiters]) {
          if (w.pred(line)) {
            waiters.splice(waiters.indexOf(w), 1);
            w.resolve(line);
          }
        }
        nl = buf.indexOf("\n");
      }
    }
  })();
  const stderrText = new Response(proc.stderr).text();
  let nextId = 1;
  const send = (msg: Record<string, unknown>) => {
    const sink = proc.stdin as Bun.FileSink;
    sink.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
    sink.flush();
  };
  const waitFor = (pred: (line: string) => boolean, label: string, timeoutMs = 8000) =>
    new Promise<string>((resolve, reject) => {
      const hit = lines.find(pred);
      if (hit) return resolve(hit);
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
      waiters.push({
        pred,
        resolve: (l) => {
          clearTimeout(timer);
          resolve(l);
        },
      });
    });
  const request = async (method: string, params: unknown) => {
    const id = nextId++;
    send({ id, method, params });
    const line = await waitFor((l) => {
      if (!l.startsWith("{")) return false;
      try {
        return (JSON.parse(l) as { id?: unknown }).id === id;
      } catch {
        return false;
      }
    }, `response to ${method} (#${id})`);
    return JSON.parse(line) as JsonRpcResponse;
  };
  return {
    send,
    request,
    waitFor,
    lines,
    updates: () =>
      lines
        .filter((l) => l.startsWith("{"))
        .map((l) => JSON.parse(l) as { method?: string; params?: { sessionId?: string; update?: { sessionUpdate?: string; content?: { text?: string } } } })
        .filter((m) => m.method === "session/update")
        .map((m) => m.params ?? {}),
    stderr: () => stderrText,
    close: async () => {
      await (proc.stdin as Bun.FileSink).end();
      return proc.exited;
    },
    kill: () => {
      try {
        proc.kill();
      } catch {
        // gone
      }
    },
  };
}

/** What Buzz's harness renders as the prompt for a mention (its `<context>` + `<buzz-event>` framing). */
export function buzzFramedPrompt(opts: {
  eventId: string;
  channel: string;
  sender: string;
  content: string;
  kind?: number;
  threadRoot?: string;
  time?: string;
  senderLabel?: string;
}): string {
  const ctx = [
    `Scope: ${opts.threadRoot ? "thread" : "channel"}`,
    `Session scope: ${opts.threadRoot ? "thread" : "channel"}`,
    `Channel: general (#${opts.channel})`,
    ...(opts.threadRoot ? [`Thread root: ${opts.threadRoot}`] : []),
    "Use `buzz messages thread --channel <UUID> --event <ID>` to fetch thread context.",
  ].join("\n");
  const tags = JSON.stringify([["h", opts.channel], ...(opts.threadRoot ? [["e", opts.threadRoot, "", "root"]] : []), ["p", "c".repeat(64)]]);
  const ev = [
    `Event ID: ${opts.eventId}`,
    `Channel: general (#${opts.channel})`,
    `Kind: ${opts.kind ?? 9}`,
    `From: ${opts.senderLabel ?? "Alice"} (npub: npub1example, hex: ${opts.sender})`,
    `Time: ${opts.time ?? "2026-09-05T10:00:00+00:00"}`,
    `Content: ${opts.content}`,
    `Tags: ${tags}`,
    `Parsed: root=${opts.threadRoot ?? "-"}`,
  ].join("\n");
  return `<context>\n${ctx}\n</context>\n\n<buzz-event>\n${ev}\n</buzz-event>`;
}

export const CHANNEL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const SENDER = "1234567890abcdef".repeat(4);

export async function waitFor(pred: () => boolean, timeoutMs = 5000, label = "condition"): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await Bun.sleep(15);
  }
  throw new Error(`timed out waiting for ${label}`);
}
