// Everything under STATE_DIR. Only the daemon writes here.
//
//   signing.key     32 random bytes (hex), 0600, generated once at first run
//   allowlist.json  signed entries, written atomically (temp + rename), 0600
//   control.secret  per-run control-channel secret, 0600
//   control.port    the loopback port the control server bound to
//   seen.txt        delivered event ids, one per line (dedup across restarts)
//   cursor.txt      last heartbeat (unix seconds) → replay window on restart
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  Allowlist,
  type AllowEntry,
  type AllowlistFile,
  type RefusedEntry,
  verifyAllowlistFile,
} from "./allowlist";
import { log, registerSecret } from "./log";

export const SEEN_KEEP = 10_000;
export const SEEN_COMPACT_AT = 20_000;

export class StateError extends Error {
  readonly exitCode = 1;
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Windows: no POSIX modes
  }
}

/** Atomic private write: temp file in the same dir, chmod 0600, rename over. */
export function writePrivateAtomic(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // Windows
  }
  renameSync(tmp, path);
}

export function readTextIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

export type StatePaths = {
  dir: string;
  signingKey: string;
  allowlist: string;
  controlSecret: string;
  controlPort: string;
  seen: string;
  cursor: string;
};

export function statePaths(dir: string): StatePaths {
  return {
    dir,
    signingKey: join(dir, "signing.key"),
    allowlist: join(dir, "allowlist.json"),
    controlSecret: join(dir, "control.secret"),
    controlPort: join(dir, "control.port"),
    seen: join(dir, "seen.txt"),
    cursor: join(dir, "cursor.txt"),
  };
}

/** Warn when a private file is readable by others (POSIX only). */
export function checkPrivateMode(path: string): void {
  if (process.platform === "win32") return;
  try {
    const mode = statSync(path).mode & 0o777;
    if (mode & 0o077) log.warn("state file is readable by other users", { path, mode: mode.toString(8) });
  } catch {
    // missing: nothing to check
  }
}

export type LoadedState = {
  paths: StatePaths;
  signingKey: Uint8Array;
  allowlist: Allowlist;
  refused: RefusedEntry[];
  /** True when the signing key was generated on this run. */
  freshKey: boolean;
};

/**
 * Initialise STATE_DIR and load the allowlist.
 *
 * - no key + no allowlist: generate the key, start empty.
 * - key + allowlist: verify every MAC; refuse bad ones, rewrite without them.
 * - no key + allowlist: refuse to start (someone could have replaced the file
 *   AND the key) unless `resetAllowlist`, which archives the old file.
 * - unparsable allowlist: same treatment as a missing key.
 */
export function loadState(opts: {
  stateDir: string;
  ownerPubkey?: string;
  resetAllowlist?: boolean;
}): LoadedState {
  const paths = statePaths(opts.stateDir);
  ensureDir(paths.dir);

  const keyText = readTextIfExists(paths.signingKey)?.trim();
  const allowlistText = readTextIfExists(paths.allowlist);
  const allowlistExists = allowlistText !== undefined;

  let signingKey: Uint8Array | undefined;
  if (keyText) {
    if (!/^[0-9a-f]{64}$/.test(keyText)) {
      if (!opts.resetAllowlist) {
        throw new StateError(
          `signing.key is corrupt at ${paths.signingKey}; refusing to start (use --reset-allowlist to start over)`,
        );
      }
    } else {
      signingKey = Buffer.from(keyText, "hex");
    }
    checkPrivateMode(paths.signingKey);
  }

  let parsed: unknown;
  let parseFailed = false;
  if (allowlistExists) {
    try {
      parsed = JSON.parse(allowlistText);
      const file = parsed as Partial<AllowlistFile> | null;
      if (!file || typeof file !== "object" || !Array.isArray(file.entries)) parseFailed = true;
    } catch {
      parseFailed = true;
    }
    checkPrivateMode(paths.allowlist);
  }

  let freshKey = false;
  if (!signingKey) {
    if (allowlistExists && !opts.resetAllowlist) {
      throw new StateError(
        `allowlist.json exists but signing.key is missing at ${paths.dir}; refusing to start. ` +
          `Restore the key, or run with --reset-allowlist to archive the file and start empty.`,
      );
    }
    if (allowlistExists) archiveAllowlist(paths, "no-signing-key");
    signingKey = new Uint8Array(randomBytes(32));
    writePrivateAtomic(paths.signingKey, Buffer.from(signingKey).toString("hex") + "\n");
    freshKey = true;
    parsed = undefined;
  } else if (parseFailed) {
    if (!opts.resetAllowlist) {
      throw new StateError(
        `allowlist.json at ${paths.allowlist} is not a valid allowlist file; refusing to start ` +
          `(use --reset-allowlist to archive it and start empty)`,
      );
    }
    archiveAllowlist(paths, "unparsable");
    parsed = undefined;
  }
  registerSecret(Buffer.from(signingKey).toString("hex"));

  let entries: AllowEntry[] = [];
  let refused: RefusedEntry[] = [];
  if (parsed !== undefined) {
    const result = verifyAllowlistFile(parsed, signingKey);
    entries = result.entries;
    refused = result.refused;
  }
  const allowlist = new Allowlist(signingKey, opts.ownerPubkey?.toLowerCase(), entries);

  if (refused.length > 0) {
    for (const r of refused) log.error("allowlist entry refused", { pubkey: r.pubkey, reason: r.reason });
    log.warn("rewriting allowlist without refused entries", { kept: entries.length, refused: refused.length });
  }
  // Always (re)write: establishes the file at first run and drops refused entries.
  saveAllowlist(paths, allowlist);
  return { paths, signingKey, allowlist, refused, freshKey };
}

function archiveAllowlist(paths: StatePaths, reason: string): void {
  const target = `${paths.allowlist}.${reason}.${Date.now()}.bak`;
  try {
    renameSync(paths.allowlist, target);
    log.warn("archived allowlist", { to: target, reason });
  } catch {
    log.warn("could not archive allowlist", { path: paths.allowlist });
  }
}

export function saveAllowlist(paths: StatePaths, allowlist: Allowlist): void {
  writePrivateAtomic(paths.allowlist, JSON.stringify(allowlist.toFile(), null, 2) + "\n");
}

export function writeControlFiles(paths: StatePaths, secret: string, port: number): void {
  writePrivateAtomic(paths.controlSecret, secret + "\n");
  writePrivateAtomic(paths.controlPort, String(port) + "\n");
}

export function readControlFiles(paths: StatePaths): { secret: string; port: number } | undefined {
  const secret = readTextIfExists(paths.controlSecret)?.trim();
  const portText = readTextIfExists(paths.controlPort)?.trim();
  if (!secret || !portText) return undefined;
  const port = Number.parseInt(portText, 10);
  if (!Number.isFinite(port) || port <= 0) return undefined;
  return { secret, port };
}

export function removeControlFiles(paths: StatePaths): void {
  for (const p of [paths.controlSecret, paths.controlPort]) {
    try {
      if (existsSync(p)) writePrivateAtomic(p, "");
    } catch {
      // best effort
    }
  }
}

/** Persistent dedup set with a bounded on-disk footprint. */
export class SeenStore {
  private readonly set = new Set<string>();
  private readonly order: string[] = [];

  constructor(
    private readonly path: string | undefined,
    private readonly keep = SEEN_KEEP,
  ) {
    if (!path) return;
    const text = readTextIfExists(path);
    if (!text) return;
    const lines = text.split("\n").filter(Boolean);
    const tail = lines.slice(-keep);
    for (const id of tail) this.addMemory(id);
    if (lines.length > SEEN_COMPACT_AT) {
      try {
        writePrivateAtomic(path, tail.join("\n") + "\n");
      } catch {
        // best effort
      }
    }
  }

  private addMemory(id: string): boolean {
    if (this.set.has(id)) return false;
    this.set.add(id);
    this.order.push(id);
    while (this.order.length > this.keep) {
      const old = this.order.shift();
      if (old) this.set.delete(old);
    }
    return true;
  }

  has(id: string): boolean {
    return this.set.has(id);
  }

  size(): number {
    return this.set.size;
  }

  /** Remember in memory only (this run). */
  markInMemory(id: string): boolean {
    return this.addMemory(id);
  }

  /** Persist an id so a restart will not redeliver it. */
  persist(id: string): void {
    this.addMemory(id);
    if (!this.path) return;
    try {
      writeFileSync(this.path, id + "\n", { flag: "a", mode: 0o600 });
    } catch (err) {
      log.warn("seen store append failed", { error: err instanceof Error ? err.message : "error" });
    }
  }
}

export function readCursor(path: string): number {
  const text = readTextIfExists(path)?.trim();
  if (!text) return 0;
  const n = Number.parseInt(text, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function writeCursor(path: string, ts: number): void {
  try {
    writeFileSync(path, String(ts) + "\n", { mode: 0o600 });
  } catch (err) {
    log.warn("cursor write failed", { error: err instanceof Error ? err.message : "error" });
  }
}

/**
 * Replay start after a (re)start: from the last heartbeat minus a minute of
 * slack, never further back than the configured window, never less than two
 * minutes.
 */
export function replaySince(lastBeat: number, now: number, windowMax: number): number {
  const floor = now - windowMax;
  const fromBeat = lastBeat > 0 ? lastBeat - 60 : now - 120;
  return Math.max(floor, Math.min(now - 120, fromBeat));
}
