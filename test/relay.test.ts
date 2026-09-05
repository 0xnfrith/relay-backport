import { afterEach, describe, expect, test } from "bun:test";
import { configureLog } from "../src/log";
import { AuthError, ConnectError, RelayClient, nextBackoff, BACKOFF_MAX_MS, BACKOFF_MIN_MS } from "../src/relay";
import { CHANNEL_A, MockRelay, channelMessage, keypair, waitFor } from "./helpers/mock-relay";

configureLog({ writer: () => {} });

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

function client(relay: MockRelay, kp = keypair(), extra: Partial<ConstructorParameters<typeof RelayClient>[0]> = {}) {
  const c = new RelayClient({ url: relay.url, secretKey: kp.sk, pubkey: kp.pk, authWaitMs: 300, ...extra });
  cleanups.push(() => c.disconnect());
  return c;
}

describe("relay client", () => {
  test("NIP-42: answers the challenge with a signed kind:22242 and is authed", async () => {
    const relay = new MockRelay({ requireAuth: true });
    cleanups.push(() => relay.stop());
    const kp = keypair();
    const c = client(relay, kp);
    expect(await c.connect()).toBe("authed");
    expect(c.authed).toBe(true);
    expect(relay.authAttempts).toEqual([{ pubkey: kp.pk, ok: true }]);
  });

  test("open relay (no challenge) connects after the auth wait", async () => {
    const relay = new MockRelay();
    cleanups.push(() => relay.stop());
    const c = client(relay);
    expect(await c.connect()).toBe("no-challenge");
    expect(c.authed).toBe(false);
    expect(c.connected).toBe(true);
  });

  test("auth rejection is an AuthError (exit 3)", async () => {
    const relay = new MockRelay({ requireAuth: true, allowPubkeys: [] });
    cleanups.push(() => relay.stop());
    const c = client(relay);
    let err: unknown;
    try {
      await c.connect();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).exitCode).toBe(3);
  });

  test("unreachable relay is a ConnectError (exit 2)", async () => {
    const c = new RelayClient({ url: "ws://127.0.0.1:1", secretKey: keypair().sk, pubkey: "x", authWaitMs: 100 });
    let err: unknown;
    try {
      await c.connect(3000);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConnectError);
    expect((err as ConnectError).exitCode).toBe(2);
  });

  test("query collects stored events until EOSE; subscriptions receive live events; publish gets OK", async () => {
    const relay = new MockRelay({ requireAuth: true });
    cleanups.push(() => relay.stop());
    const kp = keypair();
    const author = keypair();
    relay.store(channelMessage(author.sk, CHANNEL_A, "old", [["p", kp.pk]]));
    const c = client(relay, kp);
    await c.connect();
    const q = await c.query([{ kinds: [9], "#p": [kp.pk] }]);
    expect(q.eosed).toBe(true);
    expect(q.events.length).toBe(1);

    const live: string[] = [];
    c.req("live", [{ kinds: [9], "#h": [CHANNEL_A] }], { onEvent: (e) => live.push(e.content) });
    await waitFor(() => relay.reqsFor("live").length === 1);
    relay.publish(channelMessage(author.sk, CHANNEL_A, "new"));
    await waitFor(() => live.includes("new"));

    const pub = await c.publish({ kind: 7, tags: [["e", "a".repeat(64)]], content: "👀" });
    expect(pub.ok).toBe(true);
    expect(relay.published[0]?.id).toBe(pub.id);
    expect(relay.published[0]?.pubkey).toBe(kp.pk);
  });

  test("publish rejection surfaces the relay's message", async () => {
    const relay = new MockRelay({ rejectPublish: "blocked: read-only" });
    cleanups.push(() => relay.stop());
    const c = client(relay);
    await c.connect();
    const res = await c.publish({ kind: 7, tags: [], content: "x" });
    expect(res.ok).toBe(false);
    expect(res.message).toBe("blocked: read-only");
  });

  test("onClose fires when the relay drops the socket", async () => {
    const relay = new MockRelay();
    cleanups.push(() => relay.stop());
    let closed: number | undefined;
    const c = client(relay, keypair(), { onClose: (code) => (closed = code) });
    await c.connect();
    relay.dropAll(1001);
    await waitFor(() => closed !== undefined);
    expect(typeof closed).toBe("number");
    expect(c.connected).toBe(false);
  });

  test("backoff escalates and resets only after a healthy connection", () => {
    expect(nextBackoff(BACKOFF_MIN_MS, 0)).toBe(2000);
    expect(nextBackoff(16_000, 0)).toBe(BACKOFF_MAX_MS);
    expect(nextBackoff(BACKOFF_MAX_MS, 0)).toBe(BACKOFF_MAX_MS);
    expect(nextBackoff(BACKOFF_MAX_MS, 120_000)).toBe(BACKOFF_MIN_MS);
  });
});
