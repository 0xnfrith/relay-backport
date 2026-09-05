// Key parsing. Errors never embed the input: a malformed nsec must not end
// up in a log line via the decoder's own error text.
import { getPublicKey, nip19 } from "nostr-tools";
import { isAbsolute, join } from "node:path";

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(h)) throw new Error("invalid hex secret key");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export function parseSecretKey(input: string): Uint8Array {
  const trimmed = input.trim();
  if (trimmed.startsWith("nsec1")) {
    let decoded: ReturnType<typeof nip19.decode>;
    try {
      decoded = nip19.decode(trimmed);
    } catch {
      throw new Error("invalid nsec secret key");
    }
    if (decoded.type !== "nsec") throw new Error("expected an nsec");
    return decoded.data;
  }
  return hexToBytes(trimmed);
}

export function parsePubkey(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith("npub1")) {
    let decoded: ReturnType<typeof nip19.decode>;
    try {
      decoded = nip19.decode(trimmed);
    } catch {
      throw new Error("invalid npub");
    }
    if (decoded.type !== "npub") throw new Error("expected an npub");
    return decoded.data.toLowerCase();
  }
  const hex = trimmed.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("invalid pubkey (expected 64 hex chars or npub)");
  return hex;
}

export function pubkeyOf(secret: Uint8Array): string {
  return getPublicKey(secret);
}

/** Relative key file names resolve against systemd's $CREDENTIALS_DIRECTORY. */
export function resolveKeyFile(file: string, credentialsDirectory?: string): string {
  if (isAbsolute(file)) return file;
  if (credentialsDirectory && !file.includes("/") && !file.includes("\\")) {
    return join(credentialsDirectory, file);
  }
  return file;
}
