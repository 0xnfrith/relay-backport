// The ACP (Agent Client Protocol) server — relay-backport's only job.
//
// A Buzz harness (Buzz Desktop, or a headless `buzz-acp`) is the ACP client:
// it spawns us, speaks JSON-RPC over our stdio (NDJSON, one object per line),
// calls `initialize` → `session/new` → `session/prompt`, expects
// `session/update` notifications and a prompt result carrying a
// `stopReason`, and may send a `session/cancel` notification. The harness
// owns the relay socket, the key, discovery, the respond-to gate, the session
// scope, the thread context and memory. We own the hand-off: every prompt is
// forwarded, whole, to the configured sinks, one `agent_message_chunk`
// acknowledges delivery, and the turn ends. We never wait for a human and
// never publish a reply — the consumer answers on the relay with its own
// tooling.
//
// stdout is the JSON-RPC stream, so nothing else may ever be written to it;
// logs go to stderr, deliveries go to the sinks.
import { randomUUID } from "node:crypto";
import { rootIdOf, threadRoot, type Delivery } from "./delivery";
import { log, errMessage } from "./log";
import { promptText, resolveEvent } from "./prompt";
import type { Sink } from "./sinks/index";
import { NAME, VERSION } from "./version";

/** The newest ACP protocol version we know; we echo the client's when it is lower. */
export const ACP_PROTOCOL_VERSION = 2;

// relay-backport has exactly one "model": itself. There is no LLM to pick —
// we advertise this single entry (unstable `SessionModelState`, the
// `models` field of a `session/new`/`session/set_model` result) purely so a
// Buzz harness's model picker resolves instead of reporting "no models".
const MODEL_ID = "passthrough";
const MODEL_STATE = {
  currentModelId: MODEL_ID,
  availableModels: [
    {
      modelId: MODEL_ID,
      name: "passthrough",
      description: "Forwards each mention to the configured sinks; no LLM.",
    },
  ],
};

export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;

type JsonRpcId = string | number | null;
type JsonRpcMessage = { jsonrpc?: string; id?: JsonRpcId; method?: string; params?: unknown; result?: unknown; error?: unknown };

type Session = {
  id: string;
  cwd: string;
  title?: string;
  /** Length only — the prompt text is never logged. */
  systemPromptChars: number;
  prompts: number;
  onCancel?: () => void;
};

export type AcpServerOptions = {
  sinks: Sink[];
  /** Where our JSON-RPC lines go (stdout). */
  write: (line: string) => void;
  /** The client's JSON-RPC lines (stdin). */
  input: AsyncIterable<string>;
  relayUrl: string;
  deliveryWaitMs: number;
};

export type AcpServerHandle = {
  /** Resolves when the input ends (the client closed our stdin) and every turn has settled. */
  done: Promise<void>;
  sessions: () => number;
};

export function startAcpServer(opts: AcpServerOptions): AcpServerHandle {
  const sessions = new Map<string, Session>();
  let inFlight: Promise<unknown> = Promise.resolve();

  const send = (msg: Record<string, unknown>) => opts.write(JSON.stringify({ jsonrpc: "2.0", ...msg }));
  const reply = (id: JsonRpcId, result: unknown) => send({ id, result });
  const fail = (id: JsonRpcId, code: number, message: string) => send({ id, error: { code, message } });
  const notify = (method: string, params: unknown) => send({ method, params });
  const lifecycle = (event: Parameters<NonNullable<Sink["lifecycle"]>>[0]) => {
    for (const s of opts.sinks) {
      try {
        s.lifecycle?.(event);
      } catch {
        // a sink that cannot record lifecycle must not break the protocol
      }
    }
  };

  function onInitialize(id: JsonRpcId, params: unknown): void {
    const requested = (params as { protocolVersion?: unknown } | null)?.protocolVersion;
    const version = typeof requested === "number" && requested >= 0 ? Math.min(requested, ACP_PROTOCOL_VERSION) : ACP_PROTOCOL_VERSION;
    log.info("acp initialize", { client_protocol: requested ?? null, protocol: version });
    reply(id, {
      protocolVersion: version,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        mcpCapabilities: { http: false, sse: false, acp: false },
      },
      authMethods: [],
      agentInfo: { name: NAME, version: VERSION },
    });
  }

  function onSessionNew(id: JsonRpcId, params: unknown): void {
    const p = (params ?? {}) as { cwd?: unknown; systemPrompt?: unknown; _meta?: { systemPrompt?: { append?: unknown }; sessionTitle?: unknown } };
    const systemPrompt = typeof p.systemPrompt === "string" ? p.systemPrompt : typeof p._meta?.systemPrompt?.append === "string" ? p._meta.systemPrompt.append : "";
    const session: Session = {
      id: randomUUID(),
      cwd: typeof p.cwd === "string" ? p.cwd : "",
      title: typeof p._meta?.sessionTitle === "string" ? p._meta.sessionTitle : undefined,
      systemPromptChars: systemPrompt.length,
      prompts: 0,
    };
    sessions.set(session.id, session);
    log.info("acp session created", { session: session.id, cwd: session.cwd, system_prompt_chars: session.systemPromptChars, title: session.title ?? "" });
    lifecycle({ type: "session-new", sessionId: session.id });
    reply(id, { sessionId: session.id, models: MODEL_STATE });
  }

  /** `session/set_model` (unstable ACP path): there is only one model, so this always "succeeds" onto it. */
  function onSessionSetModel(id: JsonRpcId, params: unknown): void {
    const p = (params ?? {}) as { sessionId?: unknown };
    const session = typeof p.sessionId === "string" ? sessions.get(p.sessionId) : undefined;
    if (!session) {
      fail(id, JSONRPC_INVALID_PARAMS, "unknown sessionId");
      return;
    }
    reply(id, { models: MODEL_STATE });
  }

  async function onSessionPrompt(id: JsonRpcId, params: unknown): Promise<void> {
    const p = (params ?? {}) as { sessionId?: unknown; prompt?: unknown; _meta?: unknown };
    const session = typeof p.sessionId === "string" ? sessions.get(p.sessionId) : undefined;
    if (!session) {
      fail(id, JSONRPC_INVALID_PARAMS, "unknown sessionId");
      return;
    }
    session.prompts++;
    const text = promptText(p.prompt);
    const resolved = resolveEvent(text, p._meta);
    const delivery: Delivery = {
      event: resolved.event,
      channel: resolved.channel,
      threadRoot: threadRoot(resolved.event),
      rootId: rootIdOf(resolved.event),
      source: resolved.source,
      session: { id: session.id, cwd: session.cwd, ...(session.title ? { title: session.title } : {}) },
      prompt: text,
      ...(resolved.events ? { events: resolved.events } : {}),
      relay: opts.relayUrl,
      receivedAt: Math.floor(Date.now() / 1000),
    };
    log.info("acp prompt", { session: session.id, event: delivery.event.id, source: resolved.source, chars: text.length, sinks: opts.sinks.length });

    // Sinks are fire-and-forget from the client's point of view: we wait a
    // bounded time so the acknowledgement can be honest, then end the turn
    // whatever is still in flight. A cancel ends it at once.
    const settled: boolean[] = [];
    const all = Promise.all(
      opts.sinks.map((s) =>
        s.deliver(delivery).catch((err) => {
          log.error("sink threw", { sink: s.name, error: errMessage(err) });
          return false;
        }),
      ),
    ).then((r) => settled.push(...r));
    inFlight = inFlight.then(() => all);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race<"done" | "timeout" | "cancelled">([
      all.then(() => "done" as const),
      new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), opts.deliveryWaitMs))),
      new Promise<"cancelled">((r) => (session.onCancel = () => r("cancelled"))),
    ]);
    if (timer) clearTimeout(timer);
    session.onCancel = undefined;

    const total = opts.sinks.length;
    const plural = total === 1 ? "" : "s";
    let message: string;
    if (outcome === "done") {
      const ok = settled.filter(Boolean).length;
      message = ok === total ? `delivered to ${total} sink${plural}` : `delivered to ${ok} of ${total} sinks (${total - ok} failed)`;
    } else if (outcome === "timeout") {
      message = `handed to ${total} sink${plural} (still in flight after ${opts.deliveryWaitMs} ms)`;
    } else {
      message = `cancelled; ${total} sink${plural} may still complete`;
    }
    notify("session/update", {
      sessionId: session.id,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: message } },
    });
    reply(id, { stopReason: outcome === "cancelled" ? "cancelled" : "end_turn" });
    log.info("acp turn ended", { session: session.id, event: delivery.event.id, outcome, message });
  }

  function onSessionCancel(params: unknown): void {
    const sid = (params as { sessionId?: unknown } | null)?.sessionId;
    const session = typeof sid === "string" ? sessions.get(sid) : undefined;
    if (!session) return;
    log.info("acp cancel", { session: session.id, in_turn: Boolean(session.onCancel) });
    lifecycle({ type: "session-cancel", sessionId: session.id });
    session.onCancel?.();
  }

  async function handle(msg: JsonRpcMessage): Promise<void> {
    const hasId = msg.id !== undefined;
    if (typeof msg.method !== "string") {
      // A response to a request we never sent, or garbage with an id.
      if (hasId && msg.result === undefined && msg.error === undefined) fail(msg.id ?? null, JSONRPC_INVALID_REQUEST, "invalid request");
      return;
    }
    const id = msg.id ?? null;
    switch (msg.method) {
      case "initialize":
        if (hasId) onInitialize(id, msg.params);
        return;
      case "authenticate":
        if (hasId) reply(id, {});
        return;
      case "session/new":
        if (hasId) onSessionNew(id, msg.params);
        return;
      case "session/prompt":
        if (hasId) await onSessionPrompt(id, msg.params);
        return;
      case "session/set_model":
        if (hasId) onSessionSetModel(id, msg.params);
        return;
      case "session/cancel":
        onSessionCancel(msg.params);
        if (hasId) reply(id, {});
        return;
      default:
        if (hasId) fail(id, JSONRPC_METHOD_NOT_FOUND, `method not found: ${msg.method}`);
        else log.debug("acp notification ignored", { method: msg.method });
    }
  }

  const done = (async () => {
    // Requests are handled in arrival order; a prompt's bounded wait keeps
    // the line moving, and a cancel is dispatched at once, ahead of the queue.
    let queue: Promise<void> = Promise.resolve();
    for await (const line of opts.input) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(trimmed) as JsonRpcMessage;
      } catch {
        fail(null, JSONRPC_PARSE_ERROR, "parse error");
        continue;
      }
      if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
        fail(null, JSONRPC_INVALID_REQUEST, "invalid request");
        continue;
      }
      if (msg.method === "session/cancel") {
        await handle(msg);
        continue;
      }
      queue = queue.then(() => handle(msg)).catch((err) => log.error("acp handler failed", { error: errMessage(err) }));
    }
    await queue;
    await inFlight.catch(() => {});
    lifecycle({ type: "closed" });
    log.info("acp input closed", { sessions: sessions.size });
  })();

  return { done, sessions: () => sessions.size };
}

/** Split a byte stream into lines (without the newline). */
export async function* lines(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      yield buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
    }
  }
  if (buf.length > 0) yield buf;
}
