// The observe tap: a loopback web page that mirrors, live, every event this
// listener receives and what it decided to do with it.
//
// Two lanes feed one page:
//   left  — this daemon, in-process. Every exit of the mention pipeline is
//           tapped, so the page shows what was dropped and why, not just what
//           was delivered.
//   right — a separate harness-mode instance, which has no relay socket of its
//           own and only ever sees prompts a harness already accepted. It
//           reaches us by POSTing its delivery payload to /ingest, so the page
//           can show the prompt text a harness built — the one thing the
//           in-process lane cannot see.
//
// Loopback only, no authentication, no persistence: this is a debugging
// mirror of traffic the operator already receives, not an API.
import { formatMentionLine, type EventLike } from "./mention";
import { log } from "./log";

export const LANES = ["daemon", "harness"] as const;
export type Lane = (typeof LANES)[number];

/** Every exit of the mention pipeline, plus the harness lane's single outcome. */
export const VERDICTS = [
  "delivered",
  "delivery_failed",
  "dropped_self",
  "dropped_kind",
  "dropped_duplicate",
  "dropped_not_mentioned",
  "dropped_not_allowed",
] as const;
export type Verdict = (typeof VERDICTS)[number];

export type ObserveRecord = {
  seq: number;
  lane: Lane;
  /** When we saw it (ms since epoch). */
  observed_at: number;
  /** The event's own `created_at` (seconds), or null when unknown. */
  created_at: number | null;
  /** observed_at - created_at, in ms; null when created_at is unknown. */
  delta_ms: number | null;
  verdict: Verdict;
  reason: string;
  channel: string;
  thread_root: string;
  from: string;
  kind: number;
  /** The event exactly as it arrived. */
  event: unknown;
  /** The `MENTION|{…}` line as emitted, or null when nothing was emitted. */
  mention_line: string | null;
  /** The harness-built prompt, when the lane has one. */
  prompt?: string;
};

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

export type PaneInfo = { label: string; detail: string };

export type ObserveServerOptions = {
  host: string;
  port: number;
  /** Records retained per lane. */
  buffer: number;
  /** What fed the daemon lane, for the page's header. */
  daemonInfo: PaneInfo;
};

export type ObserveServer = {
  port: number;
  /** Tap point: called from the mention pipeline. Never throws. */
  record: (input: RecordInput) => void;
  stop: () => void;
  /** Test seam. */
  records: (lane?: Lane) => ObserveRecord[];
};

export type RecordInput = {
  lane: Lane;
  verdict: Verdict;
  reason?: string;
  event: EventLike;
  /** Emit the MENTION| line for this record (delivered records only). */
  emitted?: boolean;
  prompt?: string;
  /** Test seam. */
  now?: number;
};

function tagValue(tags: string[][] | undefined, name: string): string | undefined {
  for (const t of tags ?? []) if (t[0] === name && t[1]) return t[1];
  return undefined;
}

function threadRootOf(ev: EventLike): string {
  const eTags = (ev.tags ?? []).filter((t) => t[0] === "e" && t[1]);
  return eTags.find((t) => t[3] === "root")?.[1] ?? eTags.find((t) => t[3] === "reply")?.[1] ?? eTags[0]?.[1] ?? ev.id;
}

export function buildRecord(seq: number, input: RecordInput): ObserveRecord {
  const ev = input.event;
  const observed_at = input.now ?? Date.now();
  const created_at = Number.isFinite(ev.created_at) ? ev.created_at : null;
  return {
    seq,
    lane: input.lane,
    observed_at,
    created_at,
    delta_ms: created_at === null ? null : observed_at - created_at * 1000,
    verdict: input.verdict,
    reason: input.reason ?? "",
    channel: tagValue(ev.tags, "h") ?? "",
    thread_root: threadRootOf(ev),
    from: ev.pubkey ? ev.pubkey.slice(0, 8) : "unknown",
    kind: ev.kind,
    event: ev,
    mention_line: input.emitted ? formatMentionLine(ev) : null,
    ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
  };
}

/**
 * A harness lane delivery payload → a record. The harness sink POSTs the
 * payload shape its own docs define; every field is treated as untrusted and
 * missing ones degrade rather than throw.
 */
export function recordFromPayload(seq: number, body: unknown, now = Date.now()): ObserveRecord | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  const id = typeof b.event_id === "string" ? b.event_id : "";
  if (!id) return undefined;
  const tags = Array.isArray(b.tags)
    ? (b.tags as unknown[]).filter((t): t is string[] => Array.isArray(t) && t.every((x) => typeof x === "string"))
    : [];
  const ev: EventLike = {
    id,
    kind: typeof b.kind === "number" ? b.kind : 9,
    pubkey: typeof b.author === "string" ? b.author : "",
    content: typeof b.text === "string" ? b.text : "",
    tags,
    created_at: typeof b.created_at === "number" ? b.created_at : Math.floor(now / 1000),
  };
  return buildRecord(seq, {
    lane: "harness",
    verdict: "delivered",
    reason: typeof b.event_source === "string" ? `event_source=${b.event_source}` : "",
    event: ev,
    emitted: true,
    prompt: typeof b.prompt === "string" ? b.prompt : "",
    now,
  });
}

export function startObserveServer(opts: ObserveServerOptions): ObserveServer {
  const buffers = new Map<Lane, RingBuffer<ObserveRecord>>(LANES.map((l) => [l, new RingBuffer<ObserveRecord>(opts.buffer)]));
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  let seq = 0;
  let harnessInfo: PaneInfo = { label: "harness lane", detail: "waiting for first delivery…" };

  function broadcast(rec: ObserveRecord): void {
    const frame = encoder.encode(`data: ${JSON.stringify(rec)}\n\n`);
    for (const c of [...clients]) {
      try {
        c.enqueue(frame);
      } catch {
        clients.delete(c);
      }
    }
  }

  function push(rec: ObserveRecord): void {
    buffers.get(rec.lane)?.push(rec);
    broadcast(rec);
  }

  const server = Bun.serve({
    hostname: opts.host,
    port: opts.port,
    fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (req.method === "GET" && url.pathname === "/config") {
        return Response.json({ daemon: opts.daemonInfo, harness: harnessInfo, buffer: opts.buffer });
      }
      if (req.method === "GET" && url.pathname === "/records") {
        const n = Number.parseInt(url.searchParams.get("n") ?? "", 10);
        const wanted = Number.isFinite(n) && n > 0 ? n : undefined;
        const out = LANES.flatMap((l) => buffers.get(l)!.last(wanted)).sort((a, b) => a.seq - b.seq);
        return Response.json(out);
      }
      if (req.method === "GET" && url.pathname === "/events") {
        const replay = LANES.flatMap((l) => buffers.get(l)!.last()).sort((a, b) => a.seq - b.seq);
        let self: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            self = controller;
            clients.add(controller);
            for (const rec of replay) controller.enqueue(encoder.encode(`data: ${JSON.stringify(rec)}\n\n`));
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
        const label = url.searchParams.get("label");
        return req
          .json()
          .then((body) => {
            const rec = recordFromPayload(++seq, body);
            if (!rec) {
              seq--;
              return new Response("bad payload", { status: 400 });
            }
            const relay = (body as { relay?: unknown }).relay;
            harnessInfo = {
              label: label || "harness lane",
              detail: typeof relay === "string" && relay ? relay : harnessInfo.detail,
            };
            push(rec);
            return Response.json({ ok: true, seq: rec.seq });
          })
          .catch(() => new Response("bad json", { status: 400 }));
      }
      return new Response("not found", { status: 404 });
    },
  });

  log.info("observe page listening", { host: opts.host, port: server.port, buffer: opts.buffer });

  return {
    port: server.port ?? opts.port,
    record(input) {
      try {
        push(buildRecord(++seq, input));
      } catch {
        // the tap must never break the pipeline it observes
      }
    },
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
    records: (lane) => (lane ? buffers.get(lane)!.last() : LANES.flatMap((l) => buffers.get(l)!.last()).sort((a, b) => a.seq - b.seq)),
  };
}

/**
 * The page. One self-contained document — no build step, no bundler, no CDN,
 * nothing fetched from the network — because the whole point is that this
 * runs on loopback next to the daemon and starts with it.
 */
export const PAGE = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>listener tap</title><style>
:root{--bg:#0b0e14;--panel:#11151d;--line:#1e2530;--fg:#c8d3e0;--dim:#6b7a8d;--accent:#7dd3fc}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
header{padding:8px 12px;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:baseline}
header b{color:var(--accent);font-weight:600}
header span{color:var(--dim)}
#cols{display:grid;grid-template-columns:1fr 1fr;height:calc(100vh - 37px)}
.col{display:flex;flex-direction:column;min-width:0;border-right:1px solid var(--line)}
.col:last-child{border-right:0}
.col>h2{margin:0;padding:6px 10px;background:var(--panel);border-bottom:1px solid var(--line);font:600 12px/1.4 inherit;color:var(--accent)}
.col>h2 em{display:block;font-style:normal;font-weight:400;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.log{flex:1;overflow-y:auto;padding:8px}
.rec{border-left:2px solid var(--line);padding:4px 0 8px 8px;margin-bottom:8px}
.rec.delivered{border-left-color:#4ade80}
.rec.delivery_failed,.rec.dropped_not_allowed{border-left-color:#f87171}
.rec[class*=dropped_]{border-left-color:#fbbf24}
.rec.dropped_not_allowed{border-left-color:#f87171}
.top{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.chip{padding:0 6px;border-radius:3px;background:#1e2530;color:var(--fg);font-size:11px}
.chip.delivered{background:#14532d;color:#bbf7d0}
.chip.delivery_failed,.chip.dropped_not_allowed{background:#7f1d1d;color:#fecaca}
.chip.dropped_self,.chip.dropped_kind,.chip.dropped_duplicate,.chip.dropped_not_mentioned{background:#78350f;color:#fde68a}
.meta{color:var(--dim)}
pre{margin:4px 0 0;white-space:pre-wrap;word-break:break-word;color:var(--fg);max-height:16em;overflow:auto;background:var(--panel);padding:6px;border-radius:3px}
pre.line{color:#7dd3fc}
details summary{cursor:pointer;color:var(--dim);outline:none}
.empty{color:var(--dim);padding:8px}
</style></head><body>
<header><b>listener tap</b><span id="status">connecting…</span><span id="count"></span></header>
<div id="cols">
  <div class="col"><h2>v0.1 watch<em id="h-daemon">…</em></h2><div class="log" id="daemon"><div class="empty">waiting for events…</div></div></div>
  <div class="col"><h2>v0.2 acp<em id="h-harness">…</em></h2><div class="log" id="harness"><div class="empty">waiting for events…</div></div></div>
</div>
<script>
const logs = { daemon: document.getElementById('daemon'), harness: document.getElementById('harness') };
let n = 0;
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
function block(summary, body) {
  const d = el('details'); d.appendChild(el('summary', null, summary));
  const p = el('pre', null, body); d.appendChild(p); return d;
}
function render(rec) {
  const log = logs[rec.lane]; if (!log) return;
  const empty = log.querySelector('.empty'); if (empty) empty.remove();
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  const row = el('div', 'rec ' + rec.verdict);
  const top = el('div', 'top');
  top.appendChild(el('span', 'chip ' + rec.verdict, rec.verdict));
  top.appendChild(el('span', 'meta', new Date(rec.observed_at).toLocaleTimeString()));
  top.appendChild(el('span', 'meta', 'kind ' + rec.kind + ' · from ' + rec.from));
  if (rec.delta_ms !== null) top.appendChild(el('span', 'meta', '+' + rec.delta_ms + 'ms'));
  if (rec.reason) top.appendChild(el('span', 'meta', rec.reason));
  row.appendChild(top);
  row.appendChild(el('div', 'meta', 'h=' + (rec.channel || '—') + ' root=' + rec.thread_root.slice(0, 12)));
  if (rec.mention_line) { const p = el('pre', 'line', rec.mention_line); row.appendChild(p); }
  if (rec.prompt !== undefined) row.appendChild(block('prompt (' + rec.prompt.length + ' chars)', rec.prompt));
  row.appendChild(block('raw event', JSON.stringify(rec.event, null, 2)));
  log.appendChild(row);
  if (atBottom) log.scrollTop = log.scrollHeight;
  document.getElementById('count').textContent = (++n) + ' records';
}
fetch('/config').then(r => r.json()).then(c => {
  document.getElementById('h-daemon').textContent = c.daemon.label + ' — ' + c.daemon.detail;
  document.getElementById('h-harness').textContent = c.harness.label + ' — ' + c.harness.detail;
});
const es = new EventSource('/events');
es.onopen = () => { document.getElementById('status').textContent = 'live'; };
es.onerror = () => { document.getElementById('status').textContent = 'reconnecting…'; };
es.onmessage = (e) => { render(JSON.parse(e.data)); fetch('/config').then(r => r.json()).then(c => {
  document.getElementById('h-harness').textContent = c.harness.label + ' — ' + c.harness.detail; }); };
</script></body></html>
`;
