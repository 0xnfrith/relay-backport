import { describe, expect, test } from "bun:test";
import { ConfigError, describeConfig, loadConfig, wsUrl } from "../src/config";
import { clearSecrets, configureLog, redact } from "../src/log";
import { keypair } from "./helpers/mock-relay";
import { nip19 } from "nostr-tools";

configureLog({ writer: () => {} });

const bot = keypair();
const owner = keypair();

const files: Record<string, string> = {
  "/keys/bot.hex": bot.hex + "\n",
  "/keys/bot.nsec": nip19.nsecEncode(bot.sk),
  "/etc/rb.toml": `
relay_url = "wss://relay.example.com"
private_key_file = "/keys/bot.hex"
sinks = ["stdout", "webhook"]
kinds = [9, 45001, 45003]
owner_pubkey = "${owner.pk}"

[webhook]
url = "https://hooks.example.com/x"
timeout_ms = 1234
`,
  "/etc/rb.json": JSON.stringify({ relay_url: "https://relay.example.com/", private_key_file: "/keys/bot.nsec" }),
  "/etc/bad.toml": "relay_url = [",
};
const readFile = (p: string) => {
  const v = files[p];
  if (v === undefined) throw new Error("ENOENT");
  return v;
};

describe("config loading", () => {
  test("TOML file: values, sinks, kinds, webhook table", () => {
    const cfg = loadConfig({ configPath: "/etc/rb.toml", env: {}, readFile });
    expect(cfg.relayUrl).toBe("wss://relay.example.com");
    expect(cfg.pubkey).toBe(bot.pk);
    expect(cfg.ownerPubkey).toBe(owner.pk);
    expect(cfg.sinks).toEqual(["stdout", "webhook"]);
    expect(cfg.kinds).toEqual([9, 45001, 45003]);
    expect(cfg.webhook?.url).toBe("https://hooks.example.com/x");
    expect(cfg.webhook?.timeoutMs).toBe(1234);
    expect(cfg.webhook?.attempts).toBe(3);
  });

  test("JSON file with an nsec key file; https relay url is upgraded to wss", () => {
    const cfg = loadConfig({ configPath: "/etc/rb.json", env: {}, readFile });
    expect(cfg.wsUrl).toBe("wss://relay.example.com");
    expect(cfg.pubkey).toBe(bot.pk);
    expect(cfg.sinks).toEqual(["stdout"]);
  });

  test("env overrides the file, flags override env", () => {
    const cfg = loadConfig({
      configPath: "/etc/rb.toml",
      env: { SINKS: "stdout", KINDS: "9", RELAY_URL: "ws://env.example" },
      overrides: { relay_url: "ws://flag.example" },
      readFile,
    });
    expect(cfg.sinks).toEqual(["stdout"]);
    expect(cfg.kinds).toEqual([9]);
    expect(cfg.relayUrl).toBe("ws://flag.example");
  });

  test("relative key file resolves against CREDENTIALS_DIRECTORY", () => {
    const cfg = loadConfig({
      env: { RELAY_URL: "wss://r", PRIVATE_KEY_FILE: "bot.hex", CREDENTIALS_DIRECTORY: "/keys" },
      readFile,
    });
    expect(cfg.pubkey).toBe(bot.pk);
  });

  test("missing relay / key / bad sink / bad kinds are config errors", () => {
    expect(() => loadConfig({ env: {}, readFile })).toThrow(ConfigError);
    expect(() => loadConfig({ env: { RELAY_URL: "wss://r" }, readFile })).toThrow(/private_key_file/);
    expect(() => loadConfig({ env: { RELAY_URL: "wss://r", PRIVATE_KEY_FILE: "/nope" }, readFile })).toThrow(/cannot read/);
    expect(() =>
      loadConfig({ env: { RELAY_URL: "wss://r", PRIVATE_KEY_FILE: "/keys/bot.hex", SINKS: "carrier-pigeon" }, readFile }),
    ).toThrow(/unknown sink/);
    expect(() =>
      loadConfig({ env: { RELAY_URL: "wss://r", PRIVATE_KEY_FILE: "/keys/bot.hex", KINDS: "nine" }, readFile }),
    ).toThrow(/kinds/);
    expect(() => loadConfig({ configPath: "/etc/bad.toml", env: {}, readFile })).toThrow(/cannot parse/);
    expect(() => wsUrl("ftp://x")).toThrow(ConfigError);
  });

  test("owner-only features require an owner; webhook/exec sinks need their settings", () => {
    const base = { RELAY_URL: "wss://r", PRIVATE_KEY_FILE: "/keys/bot.hex" };
    expect(() => loadConfig({ env: { ...base, MENTION_TEXT: "@bot" }, readFile })).toThrow(/owner_pubkey/);
    expect(() => loadConfig({ env: { ...base, REACTIONS: "true" }, readFile })).toThrow(/owner_pubkey/);
    expect(() => loadConfig({ env: { ...base, SINKS: "webhook" }, readFile })).toThrow(/webhook.url/);
    expect(() => loadConfig({ env: { ...base, SINKS: "exec" }, readFile })).toThrow(/exec.command/);
    const ok = loadConfig({
      env: { ...base, SINKS: "exec,stdout", EXEC_COMMAND: "/bin/handler --flag", OWNER_PUBKEY: nip19.npubEncode(owner.pk), REACTIONS: "1" },
      readFile,
    });
    expect(ok.exec?.command).toEqual(["/bin/handler", "--flag"]);
    expect(ok.ownerPubkey).toBe(owner.pk);
    expect(ok.reactions).toBe(true);
  });

  test("the private key is registered for redaction and never appears in describeConfig", () => {
    clearSecrets();
    const cfg = loadConfig({ env: { RELAY_URL: "wss://r", PRIVATE_KEY_FILE: "/keys/bot.nsec" }, readFile });
    const nsec = nip19.nsecEncode(bot.sk);
    expect(redact(`key=${nsec}`)).toBe("key=[redacted]");
    expect(redact(`hex=${bot.hex}`)).toBe("hex=[redacted]");
    const shown = JSON.stringify(describeConfig(cfg));
    expect(shown.includes(bot.hex)).toBe(false);
    expect(shown.includes(nsec)).toBe(false);
  });

  test("a malformed nsec never echoes the input in the error", () => {
    const bad = { "/keys/bad": "nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq" };
    let message = "";
    try {
      loadConfig({ env: { RELAY_URL: "wss://r", PRIVATE_KEY_FILE: "/keys/bad" }, readFile: (p) => bad[p as keyof typeof bad] });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/not a valid key/);
    expect(message.includes("nsec1qqq")).toBe(false);
  });

  test("clientOnly mode needs neither relay nor key", () => {
    const cfg = loadConfig({ env: { STATE_DIR: "/tmp/x", CONTROL_PORT: "1234" }, readFile, clientOnly: true });
    expect(cfg.controlPort).toBe(1234);
    expect(cfg.stateDir.endsWith("x")).toBe(true);
  });
});
