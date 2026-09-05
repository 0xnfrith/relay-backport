import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ConfigError, defaultStateDir, describeConfig, loadConfig } from "../src/config";
import { clearSecrets, configureLog, redact } from "../src/log";

configureLog({ writer: () => {} });

const files: Record<string, string> = {
  "/etc/rb.toml": `
state_dir = "/var/lib/rb"
sinks = ["file", "webhook", "exec"]
delivery_wait_ms = 2500

[file]
path = "/var/log/rb/deliveries.jsonl"

[webhook]
url = "https://hooks.example.com/x"
timeout_ms = 1234

[exec]
command = ["/usr/local/bin/handle", "--from-relay"]
pass_buzz_env = true
`,
  "/etc/rb.json": JSON.stringify({ sinks: "webhook", webhook: { url: "http://127.0.0.1:9/h", attempts: 1 } }),
  "/etc/bad.toml": "sinks = [",
};
const readFile = (p: string) => {
  const v = files[p];
  if (v === undefined) throw new Error("ENOENT");
  return v;
};

describe("config loading", () => {
  test("defaults: the file sink under the platform state dir, 15 s delivery wait, text logs", () => {
    const cfg = loadConfig({ env: { HOME: "/home/u" }, readFile });
    expect(cfg.sinks).toEqual(["file"]);
    expect(cfg.stateDir).toBe("/home/u/.local/state/relay-backport");
    expect(cfg.file?.path).toBe("/home/u/.local/state/relay-backport/deliveries.jsonl");
    expect(cfg.deliveryWaitMs).toBe(15_000);
    expect(cfg.logFormat).toBe("text");
    expect(cfg.relayUrl).toBe("");
    expect(cfg.webhook).toBeUndefined();
    expect(cfg.exec).toBeUndefined();
  });

  test("state dir: XDG_STATE_HOME wins on POSIX, LOCALAPPDATA on Windows", () => {
    expect(defaultStateDir({ XDG_STATE_HOME: "/xdg", HOME: "/home/u" }, "linux")).toBe("/xdg/relay-backport");
    expect(defaultStateDir({ HOME: "/home/u" }, "darwin")).toBe("/home/u/.local/state/relay-backport");
    expect(defaultStateDir({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "win32")).toBe(join("C:\\Users\\u\\AppData\\Local", "relay-backport"));
  });

  test("TOML file: every table, arrays kept as arrays", () => {
    const cfg = loadConfig({ configPath: "/etc/rb.toml", env: {}, readFile });
    expect(cfg.stateDir).toBe("/var/lib/rb");
    expect(cfg.sinks).toEqual(["file", "webhook", "exec"]);
    expect(cfg.deliveryWaitMs).toBe(2500);
    expect(cfg.file).toEqual({ path: "/var/log/rb/deliveries.jsonl" });
    expect(cfg.webhook).toEqual({ url: "https://hooks.example.com/x", bearerFile: undefined, timeoutMs: 1234, attempts: 3 });
    expect(cfg.exec).toEqual({ command: ["/usr/local/bin/handle", "--from-relay"], timeoutMs: 60_000, passBuzzEnv: true });
    expect(cfg.configPath).toBe("/etc/rb.toml");
  });

  test("JSON file; RELAY_BACKPORT_CONFIG names the file; env overrides the file; flags override env", () => {
    const cfg = loadConfig({ env: { RELAY_BACKPORT_CONFIG: "/etc/rb.json" }, readFile });
    expect(cfg.sinks).toEqual(["webhook"]);
    expect(cfg.webhook?.attempts).toBe(1);
    const layered = loadConfig({
      configPath: "/etc/rb.toml",
      env: { RELAY_BACKPORT_SINKS: "file", RELAY_BACKPORT_FILE: "/env/deliveries.jsonl", RELAY_BACKPORT_LOG_FORMAT: "json" },
      overrides: { file: { path: "/flag/deliveries.jsonl" } },
      readFile,
    });
    expect(layered.sinks).toEqual(["file"]);
    expect(layered.file?.path).toBe("/flag/deliveries.jsonl");
    expect(layered.logFormat).toBe("json");
    expect(layered.stateDir).toBe("/var/lib/rb");
  });

  test("every RELAY_BACKPORT_* variable is honoured", () => {
    const cfg = loadConfig({
      env: {
        RELAY_BACKPORT_STATE_DIR: "/s",
        RELAY_BACKPORT_SINKS: "webhook, exec",
        RELAY_BACKPORT_DELIVERY_WAIT_MS: "100",
        RELAY_BACKPORT_WEBHOOK_URL: "https://h.example/x",
        RELAY_BACKPORT_WEBHOOK_BEARER_FILE: "/s/bearer",
        RELAY_BACKPORT_WEBHOOK_TIMEOUT_MS: "5",
        RELAY_BACKPORT_WEBHOOK_ATTEMPTS: "2",
        RELAY_BACKPORT_EXEC_COMMAND: "/bin/handle --x",
        RELAY_BACKPORT_EXEC_TIMEOUT_MS: "9",
        RELAY_BACKPORT_EXEC_PASS_BUZZ_ENV: "yes",
        BUZZ_RELAY_URL: "wss://relay.example",
      },
      readFile,
    });
    expect(cfg.stateDir).toBe("/s");
    expect(cfg.sinks).toEqual(["webhook", "exec"]);
    expect(cfg.deliveryWaitMs).toBe(100);
    expect(cfg.webhook).toEqual({ url: "https://h.example/x", bearerFile: "/s/bearer", timeoutMs: 5, attempts: 2 });
    expect(cfg.exec).toEqual({ command: ["/bin/handle", "--x"], timeoutMs: 9, passBuzzEnv: true });
    expect(cfg.relayUrl).toBe("wss://relay.example");
    expect(cfg.file).toBeUndefined();
  });

  test("errors: unreadable or unparsable file, unknown sink, missing webhook url / exec command, bad values", () => {
    expect(() => loadConfig({ configPath: "/nope.toml", env: {}, readFile })).toThrow(ConfigError);
    expect(() => loadConfig({ configPath: "/etc/bad.toml", env: {}, readFile })).toThrow(/cannot parse/);
    expect(() => loadConfig({ env: { RELAY_BACKPORT_SINKS: "stdout" }, readFile })).toThrow(/unknown sink/);
    expect(() => loadConfig({ env: { RELAY_BACKPORT_SINKS: "webhook" }, readFile })).toThrow(/webhook.url/);
    expect(() => loadConfig({ env: { RELAY_BACKPORT_SINKS: "webhook", RELAY_BACKPORT_WEBHOOK_URL: "ftp://x" }, readFile })).toThrow(/http/);
    expect(() => loadConfig({ env: { RELAY_BACKPORT_SINKS: "exec" }, readFile })).toThrow(/exec.command/);
    expect(() => loadConfig({ env: { RELAY_BACKPORT_LOG_FORMAT: "xml" }, readFile })).toThrow(/log_format/);
    expect(() => loadConfig({ env: { RELAY_BACKPORT_DELIVERY_WAIT_MS: "0" }, readFile })).toThrow(/delivery_wait_ms/);
    expect(() => loadConfig({ env: { RELAY_BACKPORT_SINKS: "exec", RELAY_BACKPORT_EXEC_COMMAND: "x", RELAY_BACKPORT_EXEC_PASS_BUZZ_ENV: "maybe" }, readFile })).toThrow(/pass_buzz_env/);
  });

  test("Buzz-injected secrets are registered for redaction at load and absent from describeConfig", () => {
    clearSecrets();
    const key = "nsec1injectedbythebuzzharnessatspawn";
    const token = "buzz-api-token-value-1234";
    const tag = "auth-tag-signature-value-9876";
    const cfg = loadConfig({ env: { BUZZ_PRIVATE_KEY: key, BUZZ_API_TOKEN: token, BUZZ_AUTH_TAG: tag, BUZZ_RELAY_URL: "wss://r.example", HOME: "/h" }, readFile });
    expect(redact(`k=${key} t=${token} a=${tag}`)).toBe("k=[redacted] t=[redacted] a=[redacted]");
    expect(JSON.stringify(describeConfig(cfg))).not.toContain(key);
    expect(describeConfig(cfg)).toMatchObject({ sinks: ["file"], relay: "wss://r.example", webhook: null, exec: null });
  });
});
