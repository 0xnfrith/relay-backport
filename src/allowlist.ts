// The allowlist and its signing.
//
// Semantics:
//   - the owner is always allowed, whatever the mention form;
//   - a listed key is allowed by p-tag only (`mode: ptag`) or by any form (`mode: any`);
//   - everyone else is dropped (and counted).
//
// Each entry carries an HMAC-SHA256 over its canonical bytes, keyed by a
// signing key that only the daemon's user can read. See README "Threat model".
import { createHmac, timingSafeEqual } from "node:crypto";

export const ALLOWLIST_VERSION = 1;

export type AllowMode = "ptag" | "any";

export type AllowEntry = {
  pubkey: string;
  mode: AllowMode;
  note?: string;
  added_at: number;
  mac: string;
};

export type AllowlistFile = {
  version: number;
  entries: AllowEntry[];
};

export type RefusedEntry = {
  pubkey: string;
  reason: "bad_mac" | "malformed";
};

export type Decision =
  | { allowed: true; by: "owner" | "ptag" | "any" }
  | { allowed: false; reason: "not_listed" | "ptag_required" };

export function isAllowMode(v: unknown): v is AllowMode {
  return v === "ptag" || v === "any";
}

/** Canonical bytes: a fixed-order JSON array so key order can never matter. */
export function canonicalBytes(entry: Omit<AllowEntry, "mac">): Buffer {
  return Buffer.from(
    JSON.stringify([ALLOWLIST_VERSION, entry.pubkey.toLowerCase(), entry.mode, entry.added_at, entry.note ?? ""]),
    "utf8",
  );
}

export function computeMac(entry: Omit<AllowEntry, "mac">, signingKey: Uint8Array): string {
  return createHmac("sha256", Buffer.from(signingKey)).update(canonicalBytes(entry)).digest("hex");
}

export function verifyMac(entry: AllowEntry, signingKey: Uint8Array): boolean {
  if (typeof entry.mac !== "string" || !/^[0-9a-f]{64}$/.test(entry.mac)) return false;
  const expected = Buffer.from(computeMac(entry, signingKey), "hex");
  const actual = Buffer.from(entry.mac, "hex");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export function signEntry(entry: Omit<AllowEntry, "mac">, signingKey: Uint8Array): AllowEntry {
  return { ...entry, mac: computeMac(entry, signingKey) };
}

function isWellFormed(raw: unknown): raw is AllowEntry {
  if (!raw || typeof raw !== "object") return false;
  const e = raw as Record<string, unknown>;
  return (
    typeof e.pubkey === "string" &&
    /^[0-9a-f]{64}$/.test(e.pubkey) &&
    isAllowMode(e.mode) &&
    typeof e.added_at === "number" &&
    Number.isInteger(e.added_at) &&
    (e.note === undefined || typeof e.note === "string") &&
    typeof e.mac === "string"
  );
}

/**
 * Verify every entry of a parsed allowlist file. Returns the entries that
 * pass and a report of the ones that were refused.
 */
export function verifyAllowlistFile(
  file: unknown,
  signingKey: Uint8Array,
): { entries: AllowEntry[]; refused: RefusedEntry[] } {
  const entries: AllowEntry[] = [];
  const refused: RefusedEntry[] = [];
  const list = (file as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(list)) return { entries, refused };
  for (const raw of list) {
    if (!isWellFormed(raw)) {
      const pk = (raw as { pubkey?: unknown } | null)?.pubkey;
      refused.push({ pubkey: typeof pk === "string" ? pk : "?", reason: "malformed" });
      continue;
    }
    if (!verifyMac(raw, signingKey)) {
      refused.push({ pubkey: raw.pubkey, reason: "bad_mac" });
      continue;
    }
    entries.push({ ...raw, pubkey: raw.pubkey.toLowerCase() });
  }
  return { entries, refused };
}

export class Allowlist {
  private readonly entries = new Map<string, AllowEntry>();

  constructor(
    private readonly signingKey: Uint8Array,
    private ownerPubkey: string | undefined,
    initial: AllowEntry[] = [],
  ) {
    this.ownerPubkey = ownerPubkey?.toLowerCase();
    for (const e of initial) this.entries.set(e.pubkey.toLowerCase(), e);
  }

  setOwner(pubkey: string | undefined): void {
    this.ownerPubkey = pubkey?.toLowerCase();
  }

  get owner(): string | undefined {
    return this.ownerPubkey;
  }

  size(): number {
    return this.entries.size;
  }

  list(): AllowEntry[] {
    return [...this.entries.values()].sort((a, b) => a.added_at - b.added_at);
  }

  get(pubkey: string): AllowEntry | undefined {
    return this.entries.get(pubkey.toLowerCase());
  }

  add(pubkey: string, mode: AllowMode, note?: string, now = Math.floor(Date.now() / 1000)): AllowEntry {
    const pk = pubkey.toLowerCase();
    const entry = signEntry({ pubkey: pk, mode, note: note?.trim() || undefined, added_at: now }, this.signingKey);
    this.entries.set(pk, entry);
    return entry;
  }

  remove(pubkey: string): boolean {
    return this.entries.delete(pubkey.toLowerCase());
  }

  /** Decide for a mention. `ptag`/`text` describe how the sender mentioned us. */
  decide(senderPubkey: string, mention: { ptag: boolean; text: boolean }): Decision {
    const pk = senderPubkey.toLowerCase();
    if (this.ownerPubkey && pk === this.ownerPubkey) return { allowed: true, by: "owner" };
    const entry = this.entries.get(pk);
    if (!entry) return { allowed: false, reason: "not_listed" };
    if (entry.mode === "any") return { allowed: true, by: "any" };
    if (mention.ptag) return { allowed: true, by: "ptag" };
    return { allowed: false, reason: "ptag_required" };
  }

  toFile(): AllowlistFile {
    return { version: ALLOWLIST_VERSION, entries: this.list() };
  }
}
