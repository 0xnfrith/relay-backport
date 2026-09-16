// The observe page: a loopback window onto the context window.
//
// In harness mode relay-backport never sees the relay — it sees what the
// harness accepted and handed over: a per-turn prompt, and once per session
// the standing system prompt. That is exactly the material a context-window
// question is asked about ("what did the agent actually read this turn, and
// how big is the window now?"), and it is otherwise invisible: the file sink
// carries only the mention itself (and whatever `file.content_max_chars`
// leaves of it) and the webhook sink POSTs into someone else's server.
//
// `relay-backport observe` runs a small server next to the harness. The
// existing `webhook` sink POSTs to its `/ingest`; the page at `/` renders
// every delivery as a two-column card — what the relay event was on the left,
// what the agent would see on the right — and keeps a per-session running
// token estimate so the growth of the window across a thread is visible.
//
// Loopback only, no authentication, no persistence: a debugging mirror of
// traffic the operator already receives, not an API. The page shows only what
// the harness accepted — the respond-to gate is upstream and invisible here.
import { log } from "./log";
import { NAME, VERSION } from "./version";

/** Rough token estimate: 4 characters per token. Good enough to watch a window grow. */
export function estimateTokens(s: string): number {
  return s ? Math.ceil(s.length / 4) : 0;
}

export function byteLength(s: string): number {
  return new TextEncoder().encode(s ?? "").length;
}

export class RingBuffer<T> {
  private items: T[] = [];
  constructor(readonly capacity: number) {}
  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.capacity) this.items.splice(0, this.items.length - this.capacity);
  }
  /** The last `n` items in arrival order; all of them when `n` is omitted. */
  last(n?: number): T[] {
    if (n === undefined || n >= this.items.length) return [...this.items];
    return n <= 0 ? [] : this.items.slice(-n);
  }
  get size(): number {
    return this.items.length;
  }
}

/** What one delivery looked like from the agent's side. */
export type ObserveRecord = {
  seq: number;
  /** When the page received it (ms since epoch). */
  observed_at: number;
  /** The event's own `created_at` (seconds), or null when absent/nonsensical. */
  created_at: number | null;
  /** observed_at - created_at, in ms; null when created_at is unknown. */
  delta_ms: number | null;
  /** How the harness resolved the event: meta | text | synthetic. A synthetic delta_ms is meaningless. */
  event_source: string;
  // the relay side
  event_id: string;
  kind: number;
  channel: string;
  thread_root: string;
  root_id: string;
  /** First 8 hex of the sender, or "unknown". */
  from: string;
  /** The full sender hex, as sent. */
  author: string;
  text: string;
  tags: string[][];
  // the agent side
  session_id: string;
  session_cwd: string;
  session_title: string;
  relay: string;
  /** The whole ACP prompt, exactly as the harness built it. */
  prompt: string;
  /** The session/new system prompt, verbatim, when the sink attached one. */
  system_prompt: string;
  sizes: {
    prompt_bytes: number;
    prompt_tokens: number;
    system_prompt_bytes: number;
    system_prompt_tokens: number;
    /** What this turn adds to the window: prompt + the system prompt only when it is new to the session. */
    turn_tokens: number;
  };
  /** The session's running totals, as of this record. */
  session_totals: SessionTotals;
};

export type SessionTotals = {
  session_id: string;
  turns: number;
  prompt_tokens: number;
  /**
   * Counted once per *change*, not once per turn — the harness sends it on
   * session/new only and the sink re-attaches it to every POST. A session that
   * alternates S → S' → S is charged for each switch: the block really did
   * change, and the ledger keeps only the last one seen, not a set.
   */
  system_prompt_tokens: number;
  total_tokens: number;
  first_seen: number;
  last_seen: number;
};

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function tagsOf(v: unknown): string[][] {
  if (!Array.isArray(v)) return [];
  return v.filter((t): t is string[] => Array.isArray(t) && t.every((x) => typeof x === "string"));
}

function tagValue(tags: string[][], name: string): string {
  for (const t of tags) if (t[0] === name && t[1]) return t[1];
  return "";
}

function threadRootOf(tags: string[][], id: string): string {
  const eTags = tags.filter((t) => t[0] === "e" && t[1]);
  return eTags.find((t) => t[3] === "root")?.[1] ?? eTags.find((t) => t[3] === "reply")?.[1] ?? eTags[0]?.[1] ?? id;
}

/** The fields an incoming payload contributes, before sequencing and session accounting. */
export type ParsedPayload = Omit<ObserveRecord, "seq" | "sizes" | "session_totals"> & {
  prompt: string;
  system_prompt: string;
};

/**
 * A webhook-sink payload → the parsed fields of a record. Every field is
 * treated as untrusted: it is read through an explicit allowlist, missing
 * fields degrade to empty rather than throwing, and nothing outside this list
 * ever reaches the page. Returns undefined when the body is not a delivery.
 */
export function parsePayload(body: unknown, now = Date.now()): ParsedPayload | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const b = body as Record<string, unknown>;
  const event_id = str(b.event_id);
  if (!event_id) return undefined;
  if (typeof b.prompt !== "string") return undefined;
  const tags = tagsOf(b.tags);
  const created_at = typeof b.created_at === "number" && Number.isFinite(b.created_at) && b.created_at > 0 ? b.created_at : null;
  const author = str(b.author);
  const session = b.session && typeof b.session === "object" ? (b.session as Record<string, unknown>) : {};
  return {
    observed_at: now,
    created_at,
    delta_ms: created_at === null ? null : now - created_at * 1000,
    event_source: str(b.event_source, "unknown"),
    event_id,
    kind: typeof b.kind === "number" ? b.kind : 0,
    channel: str(b.channel) || tagValue(tags, "h"),
    thread_root: str(b.thread_root) || threadRootOf(tags, event_id),
    root_id: str(b.root_id),
    from: author ? author.slice(0, 8) : "unknown",
    author,
    text: str(b.text),
    tags,
    session_id: str(session.id),
    session_cwd: str(session.cwd),
    session_title: str(session.title),
    relay: str(b.relay),
    prompt: b.prompt,
    system_prompt: str(b.system_prompt),
  };
}

/**
 * Per-session accounting. The point of the whole page: the harness sends the
 * standing system prompt ONCE, on `session/new`, and the webhook sink then
 * attaches that same text to every POST in the session. Counting it per turn
 * would multiply 20-40 KB by the turn count and overstate the window by an
 * order of magnitude — so a system prompt is counted the first time it is
 * seen for a session, and again only if its text actually changed.
 */
export class SessionLedger {
  private totals = new Map<string, SessionTotals>();
  private lastSystemPrompt = new Map<string, string>();

  /** Fold one parsed delivery in; returns its own sizes and the session's running totals. */
  add(p: ParsedPayload): { sizes: ObserveRecord["sizes"]; totals: SessionTotals } {
    const key = p.session_id || "(no session)";
    const promptTokens = estimateTokens(p.prompt);
    const systemTokens = estimateTokens(p.system_prompt);
    const isNewSystemPrompt = p.system_prompt !== "" && this.lastSystemPrompt.get(key) !== p.system_prompt;
    if (isNewSystemPrompt) this.lastSystemPrompt.set(key, p.system_prompt);

    let t = this.totals.get(key);
    if (!t) {
      t = {
        session_id: key,
        turns: 0,
        prompt_tokens: 0,
        system_prompt_tokens: 0,
        total_tokens: 0,
        first_seen: p.observed_at,
        last_seen: p.observed_at,
      };
      this.totals.set(key, t);
    }
    t.turns += 1;
    t.prompt_tokens += promptTokens;
    if (isNewSystemPrompt) t.system_prompt_tokens += systemTokens;
    t.total_tokens = t.prompt_tokens + t.system_prompt_tokens;
    t.last_seen = p.observed_at;

    return {
      sizes: {
        prompt_bytes: byteLength(p.prompt),
        prompt_tokens: promptTokens,
        system_prompt_bytes: byteLength(p.system_prompt),
        system_prompt_tokens: systemTokens,
        turn_tokens: promptTokens + (isNewSystemPrompt ? systemTokens : 0),
      },
      totals: { ...t },
    };
  }

  get(sessionId: string): SessionTotals | undefined {
    const t = this.totals.get(sessionId || "(no session)");
    return t ? { ...t } : undefined;
  }

  all(): SessionTotals[] {
    return [...this.totals.values()].map((t) => ({ ...t }));
  }
}

export const DEFAULT_PORT = 7479;
export const DEFAULT_BUFFER = 200;
export const DEFAULT_BIND = "127.0.0.1";

/**
 * The largest body `/ingest` will read: 1 MiB. A delivery is a per-turn prompt
 * plus a standing system prompt — 20-40 KB is the realistic ceiling — and every
 * accepted body is retained in the ring buffer, so an uncapped POST is an
 * uncapped allocation multiplied by `--buffer`. Bun's own default is 128 MB.
 */
export const MAX_INGEST_BYTES = 1024 * 1024;

/**
 * Read a request body, refusing at `max` bytes. Bun's `maxRequestBodySize` is
 * set too, but it does not stop a chunked POST that declares no length, so the
 * cap is counted here as the body streams in — nothing over the limit is ever
 * fully held. Returns undefined when the body is too large.
 */
export async function readCappedBody(req: Request, max: number): Promise<string | undefined> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) return undefined;
  const body = req.body;
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let out = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      // Drain and discard the rest rather than cancelling: cancelling mid-body
      // leaves the keep-alive connection desynchronised and the sender's NEXT
      // delivery is read as garbage. Nothing over the cap is retained.
      out = "";
      while (!(await reader.read()).done) {
        /* discard */
      }
      return undefined;
    }
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

/** Loopback hosts the page is safe on; anything else is a routable listener. */
export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || h === "::ffff:127.0.0.1" || /^127\./.test(h);
}

export type ObserveServerOptions = {
  host?: string;
  port?: number;
  /** Records retained for replay. */
  buffer?: number;
  /** Test seam. */
  now?: () => number;
};

export type ObserveServer = {
  port: number;
  /** Test seam: the buffered records. */
  records: () => ObserveRecord[];
  sessions: () => SessionTotals[];
  stop: () => void;
};

export function startObserveServer(opts: ObserveServerOptions = {}): ObserveServer {
  const capacity = opts.buffer ?? DEFAULT_BUFFER;
  const buffer = new RingBuffer<ObserveRecord>(capacity);
  const ledger = new SessionLedger();
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  const now = opts.now ?? (() => Date.now());
  let seq = 0;

  function frame(rec: ObserveRecord): Uint8Array {
    return encoder.encode(`data: ${JSON.stringify(rec)}\n\n`);
  }

  function push(rec: ObserveRecord): void {
    buffer.push(rec);
    const f = frame(rec);
    for (const c of [...clients]) {
      try {
        c.enqueue(f);
      } catch {
        clients.delete(c);
      }
    }
  }

  const page = renderPage({ buffer: capacity });

  const host = opts.host ?? DEFAULT_BIND;
  if (!isLoopbackHost(host)) {
    log.warn("observe is binding to a NON-LOOPBACK address: it has no authentication and serves every prompt the agent received in full", {
      host,
      advice: "bind 127.0.0.1 unless you control the network",
    });
  }

  const server = Bun.serve({
    hostname: host,
    port: opts.port ?? DEFAULT_PORT,
    maxRequestBodySize: MAX_INGEST_BYTES,
    fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (req.method === "GET" && url.pathname === "/records") {
        return Response.json(buffer.last());
      }
      if (req.method === "GET" && url.pathname === "/sessions") {
        return Response.json(ledger.all());
      }
      if (req.method === "GET" && url.pathname === "/events") {
        const replay = buffer.last();
        let self: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            self = controller;
            clients.add(controller);
            for (const rec of replay) controller.enqueue(frame(rec));
            controller.enqueue(encoder.encode(": open\n\n"));
          },
          cancel() {
            clients.delete(self);
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
        });
      }
      if (req.method === "POST" && url.pathname === "/ingest") {
        return readCappedBody(req, MAX_INGEST_BYTES)
          .then((text) => {
            if (text === undefined) return new Response("payload too large", { status: 413 });
            let body: unknown;
            try {
              body = JSON.parse(text);
            } catch {
              return new Response("bad json", { status: 400 });
            }
            // Validate before allocating: junk must never burn a sequence number.
            const parsed = parsePayload(body, now());
            if (!parsed) return new Response("bad payload", { status: 400 });
            const { sizes, totals } = ledger.add(parsed);
            const rec: ObserveRecord = { seq: ++seq, ...parsed, sizes, session_totals: totals };
            push(rec);
            return Response.json({ ok: true, seq: rec.seq });
          })
          .catch(() => new Response("bad json", { status: 400 }));
      }
      return new Response("not found", { status: 404 });
    },
  });

  log.info("observe page listening", { host, port: server.port, buffer: capacity, max_body_bytes: MAX_INGEST_BYTES });

  return {
    port: server.port ?? opts.port ?? DEFAULT_PORT,
    records: () => buffer.last(),
    sessions: () => ledger.all(),
    stop: () => {
      for (const c of [...clients]) {
        try {
          c.close();
        } catch {
          // already gone
        }
      }
      clients.clear();
      server.stop(true);
    },
  };
}

/**
 * The page. One self-contained document — no `<script src>`, no stylesheet
 * link, no font, no CDN, nothing fetched from anywhere but this server's own
 * SSE stream — because the whole point is that it runs on loopback next to a
 * harness, with no network of its own and nothing to leak a prompt to.
 */
export function renderPage(cfg: { buffer: number }): string {
  const boot = JSON.stringify({ buffer: cfg.buffer, name: NAME, version: VERSION }).replace(/</g, "\\u003c");
  return String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>observe — what the agent sees</title><style>
:root{--bg:#0b0e14;--panel:#11151d;--line:#1e2530;--fg:#c8d3e0;--dim:#6b7a8d;--accent:#7dd3fc;--warm:#fbbf24;--good:#4ade80}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
header{padding:8px 12px;border-bottom:1px solid var(--line);display:flex;gap:14px;align-items:baseline;flex-wrap:wrap}
header b{color:var(--accent);font-weight:600}
header span{color:var(--dim)}
#wrap{display:grid;grid-template-columns:260px 1fr;height:calc(100vh - 38px)}
#sessions{border-right:1px solid var(--line);overflow-y:auto;padding:8px;background:var(--panel)}
#sessions h2,#feed h2{margin:0 0 6px;font:600 12px/1.4 inherit;color:var(--accent)}
.sess{border-left:2px solid var(--line);padding:2px 0 6px 8px;margin-bottom:8px}
.sess .id{color:var(--fg)}
.sess .n{color:var(--warm)}
.bar{height:4px;background:#1e2530;border-radius:2px;margin-top:3px;overflow:hidden}
.bar i{display:block;height:100%;background:var(--accent)}
#feed{overflow-y:auto;padding:8px;min-width:0}
.rec{border:1px solid var(--line);border-left:2px solid var(--good);border-radius:3px;padding:6px 8px;margin-bottom:10px}
.top{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:4px}
.chip{padding:0 6px;border-radius:3px;background:#1e2530;font-size:11px}
.chip.tok{background:#14532d;color:#bbf7d0}
.meta{color:var(--dim)}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:10px;min-width:0}
.cols>div{min-width:0}
.cols h3{margin:0 0 4px;font:600 11px/1.4 inherit;color:var(--warm);text-transform:uppercase;letter-spacing:.04em}
pre{margin:4px 0 0;white-space:pre-wrap;word-break:break-word;max-height:22em;overflow:auto;background:var(--panel);padding:6px;border-radius:3px}
details{margin-top:4px}
details summary{cursor:pointer;color:var(--accent);outline:none}
.kv{color:var(--dim)}
.kv b{color:var(--fg);font-weight:400}
.empty{color:var(--dim);padding:8px}
@media (max-width:820px){#wrap{grid-template-columns:1fr;height:auto}.cols{grid-template-columns:1fr}}
</style></head><body>
<header><b>observe</b><span id="ver"></span><span id="status">connecting…</span><span id="count"></span>
<span class="meta">left: the relay event · right: what the agent would see · tokens ≈ chars/4</span></header>
<div id="wrap">
  <aside id="sessions"><h2>session context</h2><div id="sesslist"><div class="empty">no sessions yet</div></div></aside>
  <main id="feed"><h2>deliveries (newest first)</h2><div id="list"><div class="empty">waiting for a delivery…<br>point the webhook sink at this server's /ingest</div></div></main>
</div>
<script>
var BOOT = ${boot};
document.getElementById('ver').textContent = BOOT.name + ' ' + BOOT.version + ' · buffer ' + BOOT.buffer;
var list = document.getElementById('list');
var sesslist = document.getElementById('sesslist');
var sessions = {};
var seen = {};
var n = 0;
function el(tag, cls, text){ var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
function num(x){ return (x||0).toLocaleString(); }
function block(summary, body){
  var d = el('details'); d.appendChild(el('summary', null, summary)); d.appendChild(el('pre', null, body)); return d;
}
function sized(label, text, bytes, tokens){
  return block(label + ' — ' + num(bytes) + ' bytes · ~' + num(tokens) + ' tokens', text);
}
function renderSessions(){
  sesslist.textContent = '';
  var keys = Object.keys(sessions);
  if (!keys.length){ sesslist.appendChild(el('div','empty','no sessions yet')); return; }
  var max = 1;
  keys.forEach(function(k){ if (sessions[k].total_tokens > max) max = sessions[k].total_tokens; });
  keys.sort(function(a,b){ return sessions[b].last_seen - sessions[a].last_seen; });
  keys.forEach(function(k){
    var t = sessions[k];
    var d = el('div','sess');
    d.appendChild(el('div','id', t.session_id.slice(0,20)));
    d.appendChild(el('div','n', '~' + num(t.total_tokens) + ' tokens'));
    d.appendChild(el('div','meta', t.turns + ' turns · prompts ~' + num(t.prompt_tokens) + ' · system ~' + num(t.system_prompt_tokens)));
    var bar = el('div','bar'); var i = el('i'); i.style.width = Math.round(100 * t.total_tokens / max) + '%'; bar.appendChild(i); d.appendChild(bar);
    sesslist.appendChild(d);
  });
}
function render(rec){
  if (seen[rec.seq]) return; // /events replays the buffer on every reconnect
  seen[rec.seq] = 1;
  var empty = list.querySelector('.empty'); if (empty) empty.remove();
  var row = el('div','rec');
  var top = el('div','top');
  top.appendChild(el('span','meta', new Date(rec.observed_at).toLocaleTimeString()));
  if (rec.delta_ms !== null) top.appendChild(el('span','meta', '+' + num(rec.delta_ms) + 'ms' + (rec.event_source === 'synthetic' ? ' (synthetic)' : '')));
  top.appendChild(el('span','chip', 'from ' + rec.from));
  top.appendChild(el('span','chip', 'h ' + (rec.channel ? rec.channel.slice(0,12) : '—')));
  top.appendChild(el('span','chip', 'session ' + (rec.session_id ? rec.session_id.slice(0,12) : '—')));
  top.appendChild(el('span','chip tok', '+~' + num(rec.sizes.turn_tokens) + ' tok · session ~' + num(rec.session_totals.total_tokens)));
  row.appendChild(top);
  var cols = el('div','cols');
  var left = el('div');
  left.appendChild(el('h3',null,'what the relay event was'));
  var lk = el('div','kv');
  lk.appendChild(el('span',null,'kind '));   lk.appendChild(el('b',null,String(rec.kind)));
  lk.appendChild(el('span',null,' · id '));  lk.appendChild(el('b',null,rec.event_id.slice(0,16)));
  lk.appendChild(el('span',null,' · root '));lk.appendChild(el('b',null,(rec.thread_root||'—').slice(0,16)));
  lk.appendChild(el('span',null,' · source '));lk.appendChild(el('b',null,rec.event_source));
  left.appendChild(lk);
  left.appendChild(sized('content', rec.text, rec.text.length, Math.ceil(rec.text.length/4)));
  left.appendChild(block('tags (' + rec.tags.length + ')', JSON.stringify(rec.tags, null, 2)));
  var right = el('div');
  right.appendChild(el('h3',null,'what the agent would see'));
  var d = sized('prompt (the full text the harness built)', rec.prompt, rec.sizes.prompt_bytes, rec.sizes.prompt_tokens);
  d.open = true; right.appendChild(d);
  if (rec.system_prompt) right.appendChild(sized('system prompt (standing context, counted once per session)', rec.system_prompt, rec.sizes.system_prompt_bytes, rec.sizes.system_prompt_tokens));
  var ident = 'relay: ' + (rec.relay || '—') + '\n' +
              'agent session: ' + (rec.session_id || '—') + '\n' +
              'cwd: ' + (rec.session_cwd || '—') + '\n' +
              'title: ' + (rec.session_title || '—') + '\n' +
              'sender: ' + (rec.author || 'unknown') + '\n' +
              'channel: ' + (rec.channel || '—');
  right.appendChild(block('buzz identity', ident));
  cols.appendChild(left); cols.appendChild(right);
  row.appendChild(cols);
  list.insertBefore(row, list.firstChild);
  sessions[rec.session_totals.session_id] = rec.session_totals;
  renderSessions();
  document.getElementById('count').textContent = (++n) + ' deliveries';
}
var es = new EventSource('/events');
es.onopen = function(){ document.getElementById('status').textContent = 'live'; };
es.onerror = function(){ document.getElementById('status').textContent = 'reconnecting…'; };
es.onmessage = function(e){ render(JSON.parse(e.data)); };
</script></body></html>
`;
}
