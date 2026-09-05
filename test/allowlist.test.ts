import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { Allowlist, canonicalBytes, computeMac, signEntry, verifyAllowlistFile, verifyMac } from "../src/allowlist";
import { keypair } from "./helpers/mock-relay";

const key = new Uint8Array(randomBytes(32));
const owner = keypair();
const agent = keypair();
const stranger = keypair();

describe("allowlist decisions", () => {
  test("owner is always allowed, by p-tag or by text", () => {
    const al = new Allowlist(key, owner.pk);
    expect(al.decide(owner.pk, { ptag: true, text: false })).toEqual({ allowed: true, by: "owner" });
    expect(al.decide(owner.pk, { ptag: false, text: true })).toEqual({ allowed: true, by: "owner" });
  });

  test("ptag-mode entries are allowed only when they p-tag us", () => {
    const al = new Allowlist(key, owner.pk);
    al.add(agent.pk, "ptag", "callback bot");
    expect(al.decide(agent.pk, { ptag: true, text: false })).toEqual({ allowed: true, by: "ptag" });
    expect(al.decide(agent.pk, { ptag: false, text: true })).toEqual({ allowed: false, reason: "ptag_required" });
  });

  test("any-mode entries are allowed in every mention form", () => {
    const al = new Allowlist(key, owner.pk);
    al.add(agent.pk, "any");
    expect(al.decide(agent.pk, { ptag: false, text: true })).toEqual({ allowed: true, by: "any" });
  });

  test("unlisted senders are dropped", () => {
    const al = new Allowlist(key, owner.pk);
    expect(al.decide(stranger.pk, { ptag: true, text: true })).toEqual({ allowed: false, reason: "not_listed" });
  });

  test("no owner configured: nobody is owner", () => {
    const al = new Allowlist(key, undefined);
    expect(al.decide(owner.pk, { ptag: true, text: false })).toEqual({ allowed: false, reason: "not_listed" });
  });

  test("add is upsert, remove works, list is sorted by added_at", () => {
    const al = new Allowlist(key, owner.pk);
    al.add(agent.pk, "ptag", undefined, 200);
    al.add(stranger.pk, "any", "second", 100);
    al.add(agent.pk, "any", "changed", 300);
    expect(al.size()).toBe(2);
    expect(al.list().map((e) => e.pubkey)).toEqual([stranger.pk, agent.pk]);
    expect(al.get(agent.pk)?.mode).toBe("any");
    expect(al.remove(agent.pk)).toBe(true);
    expect(al.remove(agent.pk)).toBe(false);
    expect(al.size()).toBe(1);
  });

  test("pubkeys are matched case-insensitively", () => {
    const al = new Allowlist(key, owner.pk.toUpperCase());
    al.add(agent.pk.toUpperCase(), "ptag");
    expect(al.decide(owner.pk, { ptag: false, text: true }).allowed).toBe(true);
    expect(al.decide(agent.pk, { ptag: true, text: false }).allowed).toBe(true);
  });
});

describe("entry signing", () => {
  test("canonical bytes are independent of key order and the mac verifies", () => {
    const entry = { pubkey: agent.pk, mode: "ptag" as const, note: "n", added_at: 1 };
    const a = canonicalBytes(entry);
    const b = canonicalBytes({ added_at: 1, note: "n", mode: "ptag", pubkey: agent.pk });
    expect(a.equals(b)).toBe(true);
    const signed = signEntry(entry, key);
    expect(signed.mac).toBe(computeMac(entry, key));
    expect(verifyMac(signed, key)).toBe(true);
  });

  test("editing any field or using another key invalidates the mac", () => {
    const signed = signEntry({ pubkey: agent.pk, mode: "ptag", added_at: 1 }, key);
    expect(verifyMac({ ...signed, mode: "any" }, key)).toBe(false);
    expect(verifyMac({ ...signed, pubkey: stranger.pk }, key)).toBe(false);
    expect(verifyMac({ ...signed, note: "x" }, key)).toBe(false);
    expect(verifyMac({ ...signed, added_at: 2 }, key)).toBe(false);
    expect(verifyMac(signed, new Uint8Array(randomBytes(32)))).toBe(false);
    expect(verifyMac({ ...signed, mac: "zz" }, key)).toBe(false);
  });

  test("verifyAllowlistFile keeps good entries and reports bad/malformed ones", () => {
    const good = signEntry({ pubkey: agent.pk, mode: "ptag", added_at: 1 }, key);
    const tampered = { ...signEntry({ pubkey: stranger.pk, mode: "ptag", added_at: 1 }, key), mode: "any" };
    const malformed = { pubkey: "not-hex", mode: "ptag", added_at: 1, mac: "00" };
    const res = verifyAllowlistFile({ version: 1, entries: [good, tampered, malformed, 42] }, key);
    expect(res.entries.map((e) => e.pubkey)).toEqual([agent.pk]);
    expect(res.refused).toEqual([
      { pubkey: stranger.pk, reason: "bad_mac" },
      { pubkey: "not-hex", reason: "malformed" },
      { pubkey: "?", reason: "malformed" },
    ]);
    expect(verifyAllowlistFile(null, key)).toEqual({ entries: [], refused: [] });
  });
});
