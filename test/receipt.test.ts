import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import type { Delivery } from "../src/delivery";
import { configureLog } from "../src/log";
import {
  appendSeen,
  buildReactionTemplate,
  bytesToHex,
  decideReceipt,
  KIND_REACTION,
  loadSeen,
  parseSecretKey,
  pubkeyOf,
  publishToRelay,
  Receipts,
  seenPath,
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
});

describe("decideReceipt", () => {
  const base = { enabled: true, delivered: true, eventId: EVENT, author: SENDER, ownPubkey: OTHER, seen: false };

  test("sends when enabled, delivered, not own, not seen", () => {
    expect(decideReceipt(base)).toEqual({ send: true });
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
  test("survives a restart: the same event id is still seen", () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const path = seenPath(t.dir);
    expect(loadSeen(path).size).toBe(0);
    appendSeen(path, EVENT);
    appendSeen(path, EVENT);
    const loaded = loadSeen(path);
    expect(loaded.has(EVENT)).toBe(true);
    expect(loaded.size).toBe(1);
    expect(readFileSync(path, "utf8").split("\n").filter(Boolean)).toEqual([EVENT, EVENT]);
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

    expect(loadSeen(seenPath(t.dir)).has(EVENT)).toBe(true);

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
    await restarted.afterDelivery(delivery(), true);
    expect(published).toHaveLength(1);
  });

  test("disabled: never publishes and never writes a seen file", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
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
    await r.afterDelivery(delivery(), true);
    expect(calls).toBe(0);
    expect(existsSync(seenPath(t.dir))).toBe(false);
  });

  test("a failed publish logs and does not throw; the event stays seen so it is not retried", async () => {
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
});
