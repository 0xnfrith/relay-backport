import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { signEntry } from "../src/allowlist";
import { configureLog } from "../src/log";
import { SeenStore, StateError, loadState, replaySince, saveAllowlist, statePaths, writePrivateAtomic } from "../src/state";
import { keypair } from "./helpers/mock-relay";
import { tmpDir } from "./helpers/tmp";

configureLog({ writer: () => {} });

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function fresh(): string {
  const t = tmpDir();
  cleanups.push(t.cleanup);
  return t.dir;
}

const owner = keypair();
const agent = keypair();

describe("state directory", () => {
  test("first run generates a 0600 signing key and an empty allowlist", () => {
    const dir = fresh();
    const s = loadState({ stateDir: dir, ownerPubkey: owner.pk });
    expect(s.freshKey).toBe(true);
    expect(s.allowlist.size()).toBe(0);
    const p = statePaths(dir);
    expect(existsSync(p.signingKey)).toBe(true);
    expect(existsSync(p.allowlist)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(p.signingKey).mode & 0o777).toBe(0o600);
      expect(statSync(p.allowlist).mode & 0o777).toBe(0o600);
    }
    expect(JSON.parse(readFileSync(p.allowlist, "utf8"))).toEqual({ version: 1, entries: [] });
  });

  test("entries survive a restart and verify against the same key", () => {
    const dir = fresh();
    const s1 = loadState({ stateDir: dir, ownerPubkey: owner.pk });
    s1.allowlist.add(agent.pk, "ptag", "bot");
    saveAllowlist(s1.paths, s1.allowlist);
    const s2 = loadState({ stateDir: dir, ownerPubkey: owner.pk });
    expect(s2.freshKey).toBe(false);
    expect(s2.refused).toEqual([]);
    expect(s2.allowlist.get(agent.pk)?.note).toBe("bot");
  });

  test("a hand-edited entry is refused and the file is rewritten without it", () => {
    const dir = fresh();
    const s1 = loadState({ stateDir: dir, ownerPubkey: owner.pk });
    s1.allowlist.add(agent.pk, "ptag");
    saveAllowlist(s1.paths, s1.allowlist);
    const p = statePaths(dir);
    const file = JSON.parse(readFileSync(p.allowlist, "utf8")) as { entries: { mode: string }[] };
    file.entries[0]!.mode = "any"; // privilege escalation by hand
    writeFileSync(p.allowlist, JSON.stringify(file));
    const s2 = loadState({ stateDir: dir, ownerPubkey: owner.pk });
    expect(s2.refused).toEqual([{ pubkey: agent.pk, reason: "bad_mac" }]);
    expect(s2.allowlist.size()).toBe(0);
    expect(JSON.parse(readFileSync(p.allowlist, "utf8")).entries).toEqual([]);
  });

  test("an entry signed with a foreign key is refused", () => {
    const dir = fresh();
    loadState({ stateDir: dir, ownerPubkey: owner.pk });
    const p = statePaths(dir);
    const foreign = signEntry({ pubkey: agent.pk, mode: "any", added_at: 1 }, new Uint8Array(32));
    writeFileSync(p.allowlist, JSON.stringify({ version: 1, entries: [foreign] }));
    const s = loadState({ stateDir: dir, ownerPubkey: owner.pk });
    expect(s.refused[0]?.reason).toBe("bad_mac");
    expect(s.allowlist.size()).toBe(0);
  });

  test("allowlist present but signing key missing → refuse to start", () => {
    const dir = fresh();
    const s = loadState({ stateDir: dir, ownerPubkey: owner.pk });
    s.allowlist.add(agent.pk, "any");
    saveAllowlist(s.paths, s.allowlist);
    unlinkSync(s.paths.signingKey);
    expect(() => loadState({ stateDir: dir, ownerPubkey: owner.pk })).toThrow(StateError);
    // still refused on the second try; nothing was silently reset
    expect(existsSync(s.paths.allowlist)).toBe(true);
  });

  test("--reset-allowlist archives the old file and starts with a fresh key", () => {
    const dir = fresh();
    const s = loadState({ stateDir: dir, ownerPubkey: owner.pk });
    s.allowlist.add(agent.pk, "any");
    saveAllowlist(s.paths, s.allowlist);
    unlinkSync(s.paths.signingKey);
    const s2 = loadState({ stateDir: dir, ownerPubkey: owner.pk, resetAllowlist: true });
    expect(s2.freshKey).toBe(true);
    expect(s2.allowlist.size()).toBe(0);
    expect(readdirSync(dir).some((f) => f.startsWith("allowlist.json.no-signing-key."))).toBe(true);
  });

  test("an unparsable allowlist refuses to start unless reset", () => {
    const dir = fresh();
    const s = loadState({ stateDir: dir });
    writeFileSync(s.paths.allowlist, "{not json");
    expect(() => loadState({ stateDir: dir })).toThrow(StateError);
    const s2 = loadState({ stateDir: dir, resetAllowlist: true });
    expect(s2.allowlist.size()).toBe(0);
  });

  test("a corrupt signing key refuses to start", () => {
    const dir = fresh();
    const s = loadState({ stateDir: dir });
    writeFileSync(s.paths.signingKey, "garbage\n");
    expect(() => loadState({ stateDir: dir })).toThrow(StateError);
  });

  test("atomic write leaves no temp file behind", () => {
    const dir = fresh();
    const path = join(dir, "x.json");
    writePrivateAtomic(path, "1");
    writePrivateAtomic(path, "2");
    expect(readFileSync(path, "utf8")).toBe("2");
    expect(readdirSync(dir)).toEqual(["x.json"]);
  });
});

describe("seen store + cursor", () => {
  test("persisted ids survive a restart; in-memory ones do not", () => {
    const dir = fresh();
    const path = join(dir, "seen.txt");
    const a = new SeenStore(path);
    a.markInMemory("mem");
    a.persist("disk");
    expect(a.has("mem")).toBe(true);
    const b = new SeenStore(path);
    expect(b.has("disk")).toBe(true);
    expect(b.has("mem")).toBe(false);
  });

  test("keeps only the newest ids and compacts a long file", () => {
    const dir = fresh();
    const path = join(dir, "seen.txt");
    const lines = Array.from({ length: 25_000 }, (_, i) => `id${i}`);
    writeFileSync(path, lines.join("\n") + "\n");
    const s = new SeenStore(path, 10_000);
    expect(s.has("id24999")).toBe(true);
    expect(s.has("id0")).toBe(false);
    expect(readFileSync(path, "utf8").split("\n").filter(Boolean).length).toBe(10_000);
  });

  test("replay window: from last heartbeat minus slack, capped, never under 2 minutes", () => {
    const now = 1_000_000;
    expect(replaySince(0, now, 86_400)).toBe(now - 120);
    expect(replaySince(now - 10, now, 86_400)).toBe(now - 120);
    expect(replaySince(now - 3600, now, 86_400)).toBe(now - 3660);
    expect(replaySince(now - 200_000, now, 86_400)).toBe(now - 86_400);
    expect(replaySince(now - 3600, now, 600)).toBe(now - 600);
  });
});
