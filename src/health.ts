// Health endpoint: GET /healthz (and /) → JSON snapshot. Binds 127.0.0.1 by
// default; set health_host = "0.0.0.0" for containers.
import { log } from "./log";

export type HealthSnapshot = {
  ok: boolean;
  version: string;
  pubkey: string;
  relay: string;
  connected: boolean;
  authed: boolean;
  uptime_s: number;
  channels: number;
  last_event_at: number | null;
  sinks: string[];
  counters: {
    received: number;
    mentions: number;
    delivered: number;
    delivery_failed: number;
    dropped_not_allowed: number;
    dropped_self: number;
    dropped_duplicate: number;
    dropped_kind: number;
    reconnects: number;
  };
  allowlist: {
    owner: string | null;
    entries: number;
    refused: { pubkey: string; reason: string }[];
  };
  reactions: { enabled: boolean; pending: number };
  control_port: number;
};

export function startHealthServer(opts: {
  host: string;
  port: number;
  snapshot: () => HealthSnapshot;
}): { port: number; stop: () => void } {
  const server = Bun.serve({
    hostname: opts.host,
    port: opts.port,
    fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/")) {
        const snap = opts.snapshot();
        return Response.json(snap, { status: snap.ok ? 200 : 503 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  log.info("health endpoint listening", { host: opts.host, port: server.port });
  return { port: server.port ?? opts.port, stop: () => server.stop(true) };
}
