import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import type { Delivery } from "../src/delivery";
import { configureLog } from "../src/log";
import {
  buildReactionTemplate,
  bytesToHex,
  decideReceipt,
  formatLedgerLine,
  KIND_REACTION,
  loadLedger,
  parseSecretKey,
  pubkeyOf,
  publishToRelay,
  Receipts,
  seenPath,
  writeLedger,
} from "../src/receipt";
import { CHANNEL, SENDER, buzzFramedPrompt, spawnAcp, waitFor } from "./helpers/acp-client";
import { MockRelay } from "./helpers/mock-relay";
import { tmpDir } from "./helpers/tmp";

configureLog({ writer: () => {} });

const EVENT = "b".repeat(64);
const OTHER = "c".repeat(64);

function delivery(over: { event?: Partial<Delivery["event"]> } & Omit<Partial<Delivery>, "event"> = {}): Delivery {
  const event = {
    id: EVENT,
    kind: 9,
    pubkey: SENDER,
    content: "hello",
    tags: [["h", CHANNEL]],
    created_at: 1_700_000_000,
    ...(over.event ?? {}),
  };
  const { event: _ignored, ...rest } = over;
  return {
    event,
    channel: CHANNEL,
    threadRoot: EVENT,
    source: "meta",
    session: { id: "sess", cwd: "/" },
    prompt: "hello",
    systemPrompt: "",
    relay: "ws://127.0.0.1:1",
    receivedAt: 1_700_000_000,
    ...rest,
  };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
  configureLog({ writer: () => {} });
});

describe("decideReceipt", () => {
  const base = {
    enabled: true,
    delivered: true,
    eventId: EVENT,
    author: SENDER,
    channel: CHANNEL,
    source: "meta" as const,
    ownPubkey: OTHER,
    seen: false,
  };

  test("sends when enabled, delivered, not own, not seen, real event with scope", () => {
    expect(decideReceipt(base)).toEqual({ send: true });
    expect(decideReceipt({ ...base, source: "text" })).toEqual({ send: true });
  });

  test("filtered event (not written to a sink) does not get a receipt", () => {
    expect(decideReceipt({ ...base, delivered: false })).toEqual({ send: false, reason: "not-delivered" });
  });

  test("own-message rule: the harness identity's event is skipped", () => {
    expect(decideReceipt({ ...base, author: OTHER, ownPubkey: OTHER })).toEqual({ send: false, reason: "own" });
    expect(decideReceipt({ ...base, author: OTHER.toUpperCase(), ownPubkey: OTHER })).toEqual({ send: false, reason: "own" });
  });

  test("once-only rule: a seen event id is skipped", () => {
    expect(decideReceipt({ ...base, seen: true })).toEqual({ send: false, reason: "seen" });
  });

  test("synthetic deliveries and missing author or channel are skipped", () => {
    expect(decideReceipt({ ...base, source: "synthetic" })).toEqual({ send: false, reason: "synthetic" });
    expect(decideReceipt({ ...base, author: "" })).toEqual({ send: false, reason: "no-scope" });
    expect(decideReceipt({ ...base, channel: "" })).toEqual({ send: false, reason: "no-scope" });
  });

  test("disabled, missing event id", () => {
    expect(decideReceipt({ ...base, enabled: false })).toEqual({ send: false, reason: "disabled" });
    expect(decideReceipt({ ...base, eventId: "not-an-id" })).toEqual({ send: false, reason: "no-event" });
  });
});

describe("reaction template", () => {
  test("kind 7 referencing the event, its author, and the channel", () => {
    expect(buildReactionTemplate({ eventId: EVENT, reaction: "👀", author: SENDER, channel: CHANNEL, kind: 9 })).toEqual({
      kind: KIND_REACTION,
      tags: [
        ["e", EVENT],
        ["p", SENDER],
        ["h", CHANNEL],
        ["k", "9"],
      ],
      content: "👀",
    });
  });

  test("a shortcode is content as given; missing author or channel omits those tags", () => {
    expect(buildReactionTemplate({ eventId: EVENT, reaction: ":eyes:" })).toEqual({
      kind: KIND_REACTION,
      tags: [["e", EVENT]],
      content: ":eyes:",
    });
  });
});

describe("seen ledger", () => {
  test("pending then done survives a restart; legacy bare ids read as done", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const path = seenPath(t.dir);
    const records = new Map([
      [EVENT, { state: "done" as const }],
      ["a".repeat(64), { state: "pending" as const, author: SENDER, channel: CHANNEL, kind: 9 }],
    ]);
    writeLedger(path, records);
    const loaded = await loadLedger(path, 5000);
    expect(loaded.get(EVENT)).toEqual({ state: "done" });
    expect(loaded.get("a".repeat(64))).toEqual({ state: "pending", author: SENDER, channel: CHANNEL, kind: 9 });

    writeFileSync(path, `${"d".repeat(64)}\n`, { mode: 0o600 });
    const legacy = await loadLedger(path, 5000);
    expect(legacy.get("d".repeat(64))).toEqual({ state: "done" });
  });

  test("compact evicts only settled rows; pending is kept even over maxSeen", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const path = seenPath(t.dir);
    const ids = ["1".repeat(64), "2".repeat(64), "3".repeat(64)];
    writeFileSync(path, ids.map((id) => formatLedgerLine(id, { state: "done" })).join("\n") + "\n");
    const loaded = await loadLedger(path, 2);
    expect([...loaded.keys()]).toEqual(["2".repeat(64), "3".repeat(64)]);

    const pending = new Map(
      ids.map((id) => [id, { state: "pending" as const, author: SENDER, channel: CHANNEL, kind: 9 }]),
    );
    writeLedger(path, pending);
    const kept = await loadLedger(path, 2);
    expect(kept.size).toBe(3);
    for (const id of ids) expect(kept.get(id)?.state).toBe("pending");
  });
});

describe("key parse", () => {
  test("hex and nsec round-trip to the same pubkey; bad input does not echo the secret", () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    expect(pubkeyOf(parseSecretKey(bytesToHex(sk)))).toBe(pk);
    expect(() => parseSecretKey("nsec1notvalid")).toThrow(/invalid nsec/);
    try {
      parseSecretKey("nsec1thisisthekeythebuzzharnessinjectsatspawnandmustneverbelogged");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as Error).message).not.toContain("nsec1this");
    }
  });
});

describe("Receipts", () => {
  test("once-only, own-message, and filtered-event: publish is called only for the first foreign delivered event", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const sk = generateSecretKey();
    const own = getPublicKey(sk);
    const published: { kind: number; tags: string[][]; content: string }[] = [];
    const r = new Receipts({
      enabled: true,
      reaction: "👀",
      timeoutMs: 500,
      stateDir: t.dir,
      relayUrl: "ws://127.0.0.1:1",
      secret: bytesToHex(sk),
      publish: async (template) => {
        published.push(template);
        return { ok: true, id: "x".repeat(64), message: "" };
      },
    });
    await r.ready;
    expect(r.pubkey).toBe(own);

    await r.afterDelivery(delivery(), true);
    await r.afterDelivery(delivery(), true);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ kind: 7, content: "👀" });
    expect(published[0]!.tags).toContainEqual(["e", EVENT]);
    expect(published[0]!.tags).toContainEqual(["p", SENDER]);
    expect(published[0]!.tags).toContainEqual(["h", CHANNEL]);

    await r.afterDelivery(delivery({ event: { pubkey: own } }), true);
    expect(published).toHaveLength(1);

    const other = delivery({ event: { id: "d".repeat(64) } });
    await r.afterDelivery(other, false);
    expect(published).toHaveLength(1);

    const onDisk = await loadLedger(seenPath(t.dir), 5000);
    expect(onDisk.get(EVENT)).toEqual({ state: "done" });

    const restarted = new Receipts({
      enabled: true,
      reaction: "👀",
      timeoutMs: 500,
      stateDir: t.dir,
      relayUrl: "ws://127.0.0.1:1",
      secret: bytesToHex(sk),
      publish: async (template) => {
        published.push(template);
        return { ok: true, id: "y".repeat(64), message: "" };
      },
    });
    await restarted.ready;
    await restarted.afterDelivery(delivery(), true);
    expect(published).toHaveLength(1);
  });

  test("a synthetic delivery does not publish and writes no ledger row", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    let calls = 0;
    const r = new Receipts({
      enabled: true,
      reaction: "👀",
      timeoutMs: 500,
      stateDir: t.dir,
      relayUrl: "ws://127.0.0.1:1",
      secret: bytesToHex(generateSecretKey()),
      publish: async () => {
        calls++;
        return { ok: true, id: "x".repeat(64), message: "" };
      },
    });
    await r.afterDelivery(delivery({ source: "synthetic", event: { pubkey: "", tags: [] }, channel: "" }), true);
    expect(calls).toBe(0);
    expect(existsSync(seenPath(t.dir))).toBe(false);
  });

  test("synthetic, undelivered and unscoped deliveries read the key zero times", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    let reads = 0;
    const hex = bytesToHex(generateSecretKey());
    const r = new Receipts({
      enabled: true,
      reaction: "👀",
      timeoutMs: 500,
      stateDir: t.dir,
      relayUrl: "ws://127.0.0.1:1",
      secret: () => {
        reads++;
        return hex;
      },
      publish: async () => ({ ok: true, id: "x".repeat(64), message: "" }),
    });
    await r.ready;
    expect(reads).toBe(0);
    await r.afterDelivery(delivery({ source: "synthetic" }), true);
    await r.afterDelivery(delivery(), false);
    await r.afterDelivery(delivery({ event: { pubkey: "" }, channel: "" }), true);
    expect(reads).toBe(0);
  });

  test("max_seen does not drop pending: three failed publishes all retry after restart", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const ids = ["1".repeat(64), "2".repeat(64), "3".repeat(64)];
    let calls = 0;
    const r = new Receipts({
      enabled: true,
      reaction: "👀",
      timeoutMs: 500,
      maxSeen: 2,
      stateDir: t.dir,
      relayUrl: "ws://127.0.0.1:1",
      secret: bytesToHex(generateSecretKey()),
      publish: async () => {
        calls++;
        return { ok: false, id: "x".repeat(64), message: "relay down" };
      },
    });
    for (const id of ids) await r.afterDelivery(delivery({ event: { id } }), true);
    expect(calls).toBe(3);
    const onDisk = await loadLedger(seenPath(t.dir), 2);
    expect(onDisk.size).toBe(3);
    for (const id of ids) expect(onDisk.get(id)?.state).toBe("pending");

    const restarted = new Receipts({
      enabled: true,
      reaction: "👀",
      timeoutMs: 500,
      maxSeen: 2,
      stateDir: t.dir,
      relayUrl: "ws://127.0.0.1:1",
      secret: bytesToHex(generateSecretKey()),
      publish: async () => {
        calls++;
        return { ok: true, id: "y".repeat(64), message: "" };
      },
    });
    await restarted.ready;
    expect(calls).toBe(6);
  });

  test("an unreadable ledger is left byte-identical and publishes nothing", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const path = seenPath(t.dir);
    writeLedger(path, new Map([[EVENT, { state: "done" }]]));
    const before = readFileSync(path);
    chmodSync(path, 0o000);
    let calls = 0;
    const warns: string[] = [];
    configureLog({ writer: (line) => warns.push(line) });
    const r = new Receipts({
      enabled: true,
      reaction: "👀",
      timeoutMs: 500,
      stateDir: t.dir,
      relayUrl: "ws://127.0.0.1:1",
      secret: bytesToHex(generateSecretKey()),
      publish: async () => {
        calls++;
        return { ok: true, id: "x".repeat(64), message: "" };
      },
    });
    await r.ready;
    await r.afterDelivery(delivery({ event: { id: "a".repeat(64) } }), true);
    expect(calls).toBe(0);
    expect(warns.filter((l) => /receipt/.test(l))).toHaveLength(1);
    chmodSync(path, 0o600);
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  test("disabled: never parses the key, never publishes, never writes a seen file", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const warns: string[] = [];
    configureLog({ writer: (line) => warns.push(line) });
    let calls = 0;
    const r = new Receipts({
      enabled: false,
      reaction: "👀",
      timeoutMs: 500,
      stateDir: t.dir,
      relayUrl: "ws://127.0.0.1:1",
      secret: bytesToHex(generateSecretKey()),
      publish: async () => {
        calls++;
        return { ok: true, id: "x".repeat(64), message: "" };
      },
    });
    expect(r.pubkey).toBe("");
    await r.afterDelivery(delivery(), true);
    expect(calls).toBe(0);
    expect(existsSync(seenPath(t.dir))).toBe(false);
    expect(warns.join("\n")).not.toMatch(/key|receipt/);
  });

  test("a failed publish stays pending and is retried once on the next start", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    let calls = 0;
    const r = new Receipts({
      enabled: true,
      reaction: "👀",
      timeoutMs: 500,
      stateDir: t.dir,
      relayUrl: "ws://127.0.0.1:1",
      secret: bytesToHex(generateSecretKey()),
      publish: async () => {
        calls++;
        return { ok: false, id: "x".repeat(64), message: "relay down" };
      },
    });
    await r.afterDelivery(delivery(), true);
    await r.afterDelivery(delivery(), true);
    expect(calls).toBe(1);
    expect((await loadLedger(seenPath(t.dir), 5000)).get(EVENT)).toMatchObject({ state: "pending" });

    const restarted = new Receipts({
      enabled: true,
      reaction: "👀",
      timeoutMs: 500,
      stateDir: t.dir,
      relayUrl: "ws://127.0.0.1:1",
      secret: bytesToHex(generateSecretKey()),
      publish: async () => {
        calls++;
        return { ok: true, id: "y".repeat(64), message: "" };
      },
    });
    await restarted.ready;
    expect(calls).toBe(2);
    expect((await loadLedger(seenPath(t.dir), 5000)).get(EVENT)).toEqual({ state: "done" });
  });

  test("an unwritable ledger turns receipts off and does not publish", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const blocked = join(t.dir, "not-a-dir");
    writeFileSync(blocked, "file");
    let calls = 0;
    const warns: string[] = [];
    configureLog({ writer: (line) => warns.push(line) });
    const r = new Receipts({
      enabled: true,
      reaction: "👀",
      timeoutMs: 500,
      stateDir: blocked,
      relayUrl: "ws://127.0.0.1:1",
      secret: bytesToHex(generateSecretKey()),
      publish: async () => {
        calls++;
        return { ok: true, id: "x".repeat(64), message: "" };
      },
    });
    await r.afterDelivery(delivery(), true);
    expect(calls).toBe(0);
    expect(warns.filter((l) => /receipt/.test(l))).toHaveLength(1);
  });

  test("a failed publish logs exactly one warning", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const warns: string[] = [];
    configureLog({ writer: (line) => warns.push(line) });
    const r = new Receipts({
      enabled: true,
      reaction: "👀",
      timeoutMs: 500,
      stateDir: t.dir,
      relayUrl: "ws://127.0.0.1:1",
      secret: bytesToHex(generateSecretKey()),
      publish: async () => ({ ok: false, id: "x".repeat(64), message: "relay down" }),
    });
    await r.afterDelivery(delivery(), true);
    expect(warns.filter((l) => /receipt/.test(l))).toHaveLength(1);
  });
});

describe("publishToRelay", () => {
  test("signs a kind 7, AUTHs, and the relay stores it", async () => {
    const relay = new MockRelay({ requireAuth: true });
    cleanups.push(() => relay.stop());
    const sk = generateSecretKey();
    const result = await publishToRelay({
      url: relay.url,
      secretKey: sk,
      template: buildReactionTemplate({ eventId: EVENT, reaction: "👀", author: SENDER, channel: CHANNEL, kind: 9 }),
      timeoutMs: 2000,
    });
    expect(result.ok).toBe(true);
    expect(relay.authAttempts.some((a) => a.ok)).toBe(true);
    expect(relay.published).toHaveLength(1);
    expect(relay.published[0]!.kind).toBe(7);
    expect(relay.published[0]!.content).toBe("👀");
    expect(relay.published[0]!.pubkey).toBe(getPublicKey(sk));
    expect(relay.published[0]!.tags).toContainEqual(["e", EVENT]);
    expect(relay.published[0]!.tags).toContainEqual(["p", SENDER]);
    expect(relay.published[0]!.tags).toContainEqual(["h", CHANNEL]);
  });

  test("a late AUTH challenge after EVENT resends once and lands", async () => {
    const relay = new MockRelay({ lateAuth: true });
    cleanups.push(() => relay.stop());
    const sk = generateSecretKey();
    const result = await publishToRelay({
      url: relay.url,
      secretKey: sk,
      template: buildReactionTemplate({ eventId: EVENT, reaction: "👀", author: SENDER, channel: CHANNEL, kind: 9 }),
      timeoutMs: 2000,
    });
    expect(result.ok).toBe(true);
    expect(relay.eventAttempts.length).toBe(2);
    expect(relay.published).toHaveLength(1);
    expect(relay.authAttempts.some((a) => a.ok)).toBe(true);
  });

  test("a rejected publish is not ok; a timeout does not hang", async () => {
    const rejected = new MockRelay({ rejectPublish: "blocked" });
    cleanups.push(() => rejected.stop());
    const sk = generateSecretKey();
    const no = await publishToRelay({
      url: rejected.url,
      secretKey: sk,
      template: buildReactionTemplate({ eventId: EVENT, reaction: "👀" }),
      timeoutMs: 2000,
    });
    expect(no.ok).toBe(false);
    expect(no.message).toContain("blocked");

    const hung = await publishToRelay({
      url: "ws://127.0.0.1:1",
      secretKey: sk,
      template: buildReactionTemplate({ eventId: EVENT, reaction: "👀" }),
      timeoutMs: 200,
    });
    expect(hung.ok).toBe(false);
    expect(hung.message).toMatch(/timeout|websocket error|not connected|connection closed/);
  });
});

describe("acp wiring", () => {
  test("a delivered mention gets one receipt; own, filtered, and a replay do not", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const relay = new MockRelay({ requireAuth: true });
    cleanups.push(() => relay.stop());
    const sk = generateSecretKey();
    const own = getPublicKey(sk);
    const file = join(t.dir, "deliveries.jsonl");
    const c = spawnAcp(["acp"], {
      RELAY_BACKPORT_SINKS: "file",
      RELAY_BACKPORT_STATE_DIR: t.dir,
      RELAY_BACKPORT_FILE: file,
      RELAY_BACKPORT_RECEIPT_ENABLED: "true",
      RELAY_BACKPORT_RECEIPT_REACTION: "👀",
      RELAY_BACKPORT_RECEIPT_TIMEOUT_MS: "2000",
      RELAY_BACKPORT_LOG_FORMAT: "json",
      BUZZ_PRIVATE_KEY: bytesToHex(sk),
      BUZZ_RELAY_URL: relay.url,
    });
    cleanups.push(() => c.kill());

    await c.request("initialize", { protocolVersion: 2 });
    const sid = ((await c.request("session/new", { cwd: "/", mcpServers: [] })).result as { sessionId: string }).sessionId;

    const text = buzzFramedPrompt({ eventId: EVENT, channel: CHANNEL, sender: SENDER, content: "ping" });
    const r1 = await c.request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text }] });
    expect(r1.result).toEqual({ stopReason: "end_turn" });
    await waitFor(() => relay.published.length === 1, 3000, "first receipt");
    expect(relay.published[0]!.kind).toBe(7);
    expect(relay.published[0]!.content).toBe("👀");
    expect(relay.published[0]!.pubkey).toBe(own);

    const r2 = await c.request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text }] });
    expect(r2.result).toEqual({ stopReason: "end_turn" });
    await Bun.sleep(150);
    expect(relay.published).toHaveLength(1);

    const ownText = buzzFramedPrompt({ eventId: "e".repeat(64), channel: CHANNEL, sender: own, content: "from me" });
    await c.request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: ownText }] });
    await Bun.sleep(150);
    expect(relay.published).toHaveLength(1);

    expect(await c.close()).toBe(0);
    const err = await c.stderr();
    expect(err).not.toContain(bytesToHex(sk));
    expect(err).toContain("receipt published");
  }, 15_000);

  test("a failed sink does not get a receipt (filtered / not written)", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const relay = new MockRelay({ requireAuth: true });
    cleanups.push(() => relay.stop());
    const sk = generateSecretKey();
    const c = spawnAcp(["acp"], {
      RELAY_BACKPORT_SINKS: "webhook",
      RELAY_BACKPORT_STATE_DIR: t.dir,
      RELAY_BACKPORT_WEBHOOK_URL: "http://127.0.0.1:1/unreachable",
      RELAY_BACKPORT_WEBHOOK_ATTEMPTS: "1",
      RELAY_BACKPORT_WEBHOOK_TIMEOUT_MS: "200",
      RELAY_BACKPORT_RECEIPT_ENABLED: "true",
      BUZZ_PRIVATE_KEY: bytesToHex(sk),
      BUZZ_RELAY_URL: relay.url,
    });
    cleanups.push(() => c.kill());
    await c.request("initialize", { protocolVersion: 2 });
    const sid = ((await c.request("session/new", { cwd: "/", mcpServers: [] })).result as { sessionId: string }).sessionId;
    const text = buzzFramedPrompt({ eventId: EVENT, channel: CHANNEL, sender: SENDER, content: "ping" });
    const r = await c.request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text }] });
    expect(r.result).toEqual({ stopReason: "end_turn" });
    expect(c.updates()[0]!.update?.content?.text).toMatch(/failed/);
    await Bun.sleep(200);
    expect(relay.published).toHaveLength(0);
    expect(await c.close()).toBe(0);
  }, 15_000);

  test("a plain unframed prompt (synthetic id) does not publish a receipt", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const relay = new MockRelay({ requireAuth: true });
    cleanups.push(() => relay.stop());
    const sk = generateSecretKey();
    const file = join(t.dir, "deliveries.jsonl");
    const c = spawnAcp(["acp"], {
      RELAY_BACKPORT_SINKS: "file",
      RELAY_BACKPORT_STATE_DIR: t.dir,
      RELAY_BACKPORT_FILE: file,
      RELAY_BACKPORT_RECEIPT_ENABLED: "true",
      BUZZ_PRIVATE_KEY: bytesToHex(sk),
      BUZZ_RELAY_URL: relay.url,
    });
    cleanups.push(() => c.kill());
    await c.request("initialize", { protocolVersion: 2 });
    const sid = ((await c.request("session/new", { cwd: "/", mcpServers: [] })).result as { sessionId: string }).sessionId;
    const r = await c.request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "no framing at all" }] });
    expect(r.result).toEqual({ stopReason: "end_turn" });
    await Bun.sleep(200);
    expect(relay.published).toHaveLength(0);
    expect(await c.close()).toBe(0);
  }, 15_000);
});
