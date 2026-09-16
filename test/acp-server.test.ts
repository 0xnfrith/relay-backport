// `relay-backport acp` driven by an in-process ACP client the way a Buzz
// harness drives it: spawn, NDJSON over stdio, initialize → session/new →
// session/prompt, plus cancel, unknown methods and a clean exit.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DeliveryPayload } from "../src/delivery";
import { CHANNEL, SENDER, buzzFramedPrompt, spawnAcp, waitFor, type AcpClient } from "./helpers/acp-client";
import { tmpDir } from "./helpers/tmp";

const EVENT = "b".repeat(64);
const ROOT = "a".repeat(64);
const INJECTED_KEY = "nsec1thisisthekeythebuzzharnessinjectsatspawnandmustneverbelogged";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

function hookServer(got: DeliveryPayload[]) {
  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      got.push((await req.json()) as DeliveryPayload);
      return new Response("ok");
    },
  });
  cleanups.push(() => srv.stop(true));
  return srv;
}

function client(args: string[], env: Record<string, string>): AcpClient {
  const c = spawnAcp(args, env);
  cleanups.push(() => c.kill());
  return c;
}

const mentionLines = (path: string) => readFileSync(path, "utf8").split("\n").filter((l) => l.startsWith("MENTION|"));

describe("relay-backport acp", () => {
  test("full flow: initialize → session/new → session/prompt → file line + webhook POST + exec stdin, update before end_turn", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const file = join(t.dir, "deliveries.jsonl");
    const execOut = join(t.dir, "exec.jsonl");
    const hook = join(t.dir, "hook.ts");
    writeFileSync(hook, `const p = JSON.parse(await Bun.stdin.text());\nawait Bun.write(${JSON.stringify(execOut)}, (await Bun.file(${JSON.stringify(execOut)}).text().catch(() => "")) + JSON.stringify({ id: p.event_id, relay: process.env.BUZZ_RELAY_URL ?? null, key: process.env.BUZZ_PRIVATE_KEY ?? null }) + "\\n");\n`);
    const got: DeliveryPayload[] = [];
    const srv = hookServer(got);
    const c = client(["acp"], {
      RELAY_BACKPORT_SINKS: "file,webhook,exec",
      RELAY_BACKPORT_STATE_DIR: t.dir,
      RELAY_BACKPORT_FILE: file,
      RELAY_BACKPORT_WEBHOOK_URL: `http://127.0.0.1:${srv.port}/h`,
      RELAY_BACKPORT_EXEC_COMMAND: `${process.execPath} ${hook}`,
      RELAY_BACKPORT_LOG_FORMAT: "json",
      BUZZ_PRIVATE_KEY: INJECTED_KEY,
      BUZZ_RELAY_URL: "wss://relay.example",
      BUZZ_AUTH_TAG: "auth-tag-value",
    });

    const init = await c.request("initialize", { protocolVersion: 2, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } }, clientInfo: { name: "test-client", version: "0" } });
    expect(init.error).toBeUndefined();
    expect(init.result).toMatchObject({ protocolVersion: 2, authMethods: [], agentCapabilities: { loadSession: false, promptCapabilities: { image: false } }, agentInfo: { name: "relay-backport" } });
    expect((await c.request("authenticate", { methodId: "none" })).result).toEqual({});

    const created = await c.request("session/new", { cwd: "/tmp", mcpServers: [], systemPrompt: "be terse", _meta: { sessionTitle: "general" } });
    const sessionId = (created.result as { sessionId: string }).sessionId;
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    // Buzz Desktop's model picker reads this off the session/new result
    // (unstable SessionModelState) — without it the picker reports
    // "relay-backport reported no models".
    expect(created.result).toMatchObject({
      models: { currentModelId: "passthrough", availableModels: [{ modelId: "passthrough", name: "passthrough", description: "Forwards each mention to the configured sinks; no LLM." }] },
    });
    await waitFor(() => readFileSync(file, "utf8").includes(`EVENT|session|new|${sessionId}`), 3000, "session lifecycle line");

    // the file sink persists the session/new system prompt once, to a sibling
    // file (0600), and the EVENT line names its absolute path
    const promptPath = join(t.dir, "sessions", `${sessionId}.system-prompt.md`);
    expect(readFileSync(promptPath, "utf8")).toBe("be terse");
    if (process.platform !== "win32") expect(statSync(promptPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toContain(`EVENT|session|new|${sessionId}|${promptPath}`);

    // 1) a Buzz-framed prompt (no _meta)
    const text = buzzFramedPrompt({ eventId: EVENT, channel: CHANNEL, sender: SENDER, content: "bot, summarise this thread", threadRoot: ROOT });
    // Deliberately far from the client's auto-incrementing request ids (used
    // by every `c.request(...)` call below), and picked so its digits never
    // appear as a substring of the raw-JSON-RPC ids (99, 100) the garbage
    // checks near the end of this test match by `.includes(...)`.
    const promptId = 31337;
    c.send({ id: promptId, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text }] } });
    const result = JSON.parse(await c.waitFor((l) => l.startsWith("{") && l.includes(`"id":${promptId}`), "prompt result"));
    expect(result.result).toEqual({ stopReason: "end_turn" });

    // the update precedes the result on the wire, and counts every sink
    const update = c.updates()[0]!;
    expect(update.sessionId).toBe(sessionId);
    expect(update.update?.sessionUpdate).toBe("agent_message_chunk");
    expect(update.update?.content?.text).toBe("delivered to 3 sinks");
    expect(c.lines.findIndex((l) => l.includes('"session/update"'))).toBeLessThan(c.lines.findIndex((l) => l.includes(`"id":${promptId}`)));
    // stdout carries nothing but JSON-RPC
    expect(c.lines.every((l) => l.startsWith("{"))).toBe(true);

    // file sink: the v0.1 MENTION| shape
    const lines = mentionLines(file);
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]!.slice(8))).toEqual({
      kind: 9,
      from: SENDER.slice(0, 8),
      h: CHANNEL,
      content: "bot, summarise this thread",
      id: EVENT,
      tags: [["h", CHANNEL], ["e", ROOT, "", "root"], ["p", "c".repeat(64)]],
    });

    // webhook: the whole prompt, the session, the source
    expect(got.length).toBe(1);
    expect(got[0]).toMatchObject({
      source: "buzz",
      transport: "acp",
      relay: "wss://relay.example",
      channel: CHANNEL,
      event_id: EVENT,
      thread_root: ROOT,
      author: SENDER,
      text: "bot, summarise this thread",
      event_source: "text",
      prompt: text,
      session: { id: sessionId, cwd: "/tmp", title: "general" },
      // webhook.include_system_prompt defaults to true: the session/new text
      // rides along on every POST, verbatim
      system_prompt: "be terse",
    });
    // exec: JSON on stdin; BUZZ_* withheld by default
    const execLines = readFileSync(execOut, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { id: string; relay: string | null; key: string | null });
    expect(execLines).toEqual([{ id: EVENT, relay: null, key: null }]);

    // 2) the structured `_meta.buzz.events[]` shape wins over the text
    const metaEvent = { id: "d".repeat(64), kind: 9, pubkey: SENDER, content: "via meta", tags: [["h", CHANNEL], ["p", "c".repeat(64)]], created_at: 1_700_000_000 };
    const r2 = await c.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "whatever the harness rendered" }], _meta: { buzz: { events: [metaEvent] } } });
    expect(r2.result).toEqual({ stopReason: "end_turn" });
    expect(got.length).toBe(2);
    expect(got[1]).toMatchObject({ event_id: metaEvent.id, text: "via meta", author: SENDER, channel: CHANNEL, event_source: "meta", events: [metaEvent] });
    expect(JSON.parse(mentionLines(file)[1]!.slice(8))).toMatchObject({ id: metaEvent.id, from: SENDER.slice(0, 8), h: CHANNEL, content: "via meta" });

    // 3) plain text → synthetic event, sender unknown, the prompt as content
    const r3 = await c.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "no framing at all" }] });
    expect(r3.result).toEqual({ stopReason: "end_turn" });
    expect(JSON.parse(mentionLines(file)[2]!.slice(8))).toMatchObject({ from: "unknown", h: "", content: "no framing at all" });
    expect(got[2]).toMatchObject({ event_source: "synthetic", author: "", text: "no framing at all", prompt: "no framing at all" });

    // 3b) session/set_model: there is only one model, so picking it always "succeeds" back onto it
    const switched = await c.request("session/set_model", { sessionId, modelId: "passthrough" });
    expect(switched.error).toBeUndefined();
    expect(switched.result).toEqual({ models: { currentModelId: "passthrough", availableModels: [{ modelId: "passthrough", name: "passthrough", description: "Forwards each mention to the configured sinks; no LLM." }] } });
    expect((await c.request("session/set_model", { sessionId: "nope", modelId: "passthrough" })).error).toMatchObject({ code: -32602 });

    // 4) unknown method → method-not-found; unknown session → invalid params; a stray notification is silent
    expect((await c.request("session/load", { sessionId })).error).toMatchObject({ code: -32601 });
    expect((await c.request("session/prompt", { sessionId: "nope", prompt: [{ type: "text", text: "x" }] })).error).toMatchObject({ code: -32602 });
    c.send({ method: "session/whatever", params: {} });
    // 5) cancel is a notification: no response, a lifecycle line, and the session keeps working
    c.send({ method: "session/cancel", params: { sessionId } });
    await waitFor(() => readFileSync(file, "utf8").includes(`EVENT|session|cancel|${sessionId}`), 3000, "cancel lifecycle line");
    expect((await c.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "after cancel" }] })).result).toEqual({ stopReason: "end_turn" });
    expect(got.length).toBe(4);
    // 6) garbage on the wire → JSON-RPC errors, no crash
    c.send({ id: 99, foo: "bar" });
    expect(JSON.parse(await c.waitFor((l) => l.includes('"id":99'), "invalid request")).error.code).toBe(-32600);
    c.send({ id: 100, method: "initialize", params: { protocolVersion: 1 } });
    expect(JSON.parse(await c.waitFor((l) => l.includes('"id":100'), "re-initialize")).result.protocolVersion).toBe(1);

    // closing stdin ends the process cleanly with a closed line; the injected key never reached stderr
    expect(await c.close()).toBe(0);
    expect(readFileSync(file, "utf8").trimEnd().endsWith("EVENT|acp|closed")).toBe(true);
    const err = await c.stderr();
    expect(err).not.toContain(INJECTED_KEY);
    expect(err).not.toContain("thisisthekey");
    expect(err).toContain("acp initialize");
    expect(err).not.toContain("be terse");
    expect(c.lines.every((l) => l.startsWith("{"))).toBe(true);
  }, 30_000);

  test("no arguments means acp; exec.pass_buzz_env hands BUZZ_* to the hook; a failed sink is reported honestly", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const execOut = join(t.dir, "exec.jsonl");
    const hook = join(t.dir, "hook.ts");
    writeFileSync(hook, `const p = JSON.parse(await Bun.stdin.text());\nawait Bun.write(${JSON.stringify(execOut)}, JSON.stringify({ id: p.event_id, relay: process.env.BUZZ_RELAY_URL ?? null, key: process.env.BUZZ_PRIVATE_KEY ?? null, tag: process.env.BUZZ_AUTH_TAG ?? null }));\n`);
    const c = client([], {
      RELAY_BACKPORT_SINKS: "exec,webhook",
      RELAY_BACKPORT_EXEC_COMMAND: `${process.execPath} ${hook}`,
      RELAY_BACKPORT_EXEC_PASS_BUZZ_ENV: "true",
      RELAY_BACKPORT_WEBHOOK_URL: "http://127.0.0.1:1/unreachable",
      RELAY_BACKPORT_WEBHOOK_ATTEMPTS: "1",
      RELAY_BACKPORT_LOG_FORMAT: "json",
      BUZZ_PRIVATE_KEY: INJECTED_KEY,
      BUZZ_RELAY_URL: "wss://relay.example",
      BUZZ_AUTH_TAG: "auth-tag-value",
    });
    await c.request("initialize", { protocolVersion: 2 });
    const sid = ((await c.request("session/new", { cwd: "/", mcpServers: [] })).result as { sessionId: string }).sessionId;
    const r = await c.request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: buzzFramedPrompt({ eventId: EVENT, channel: CHANNEL, sender: SENDER, content: "reply please" }) }] });
    expect(r.result).toEqual({ stopReason: "end_turn" });
    expect(c.updates()[0]!.update?.content?.text).toBe("delivered to 1 of 2 sinks (1 failed)");
    expect(JSON.parse(readFileSync(execOut, "utf8"))).toEqual({ id: EVENT, relay: "wss://relay.example", key: INJECTED_KEY, tag: "auth-tag-value" });
    expect(await c.close()).toBe(0);
    const err = await c.stderr();
    expect(err).not.toContain(INJECTED_KEY);
    expect(err).toContain('"sinks":["exec","webhook"]');
  }, 20_000);

  test("a slow sink does not hold the turn past delivery_wait_ms; a cancel mid-turn ends it as cancelled", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const slow = join(t.dir, "slow.ts");
    writeFileSync(slow, "await Bun.stdin.text();\nawait Bun.sleep(3000);\n");
    const c = client(["acp"], {
      RELAY_BACKPORT_SINKS: "exec",
      RELAY_BACKPORT_EXEC_COMMAND: `${process.execPath} ${slow}`,
      RELAY_BACKPORT_EXEC_TIMEOUT_MS: "4000",
      RELAY_BACKPORT_DELIVERY_WAIT_MS: "300",
    });
    await c.request("initialize", { protocolVersion: 2 });
    const sid = ((await c.request("session/new", { cwd: "/", mcpServers: [] })).result as { sessionId: string }).sessionId;
    const started = Date.now();
    const r = await c.request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "slow" }] });
    expect(r.result).toEqual({ stopReason: "end_turn" });
    expect(Date.now() - started).toBeLessThan(2500);
    expect(c.updates()[0]!.update?.content?.text).toMatch(/still in flight after 300 ms/);

    c.send({ id: 50, method: "session/prompt", params: { sessionId: sid, prompt: [{ type: "text", text: "cancel me" }] } });
    await Bun.sleep(50);
    c.send({ method: "session/cancel", params: { sessionId: sid } });
    const cancelled = JSON.parse(await c.waitFor((l) => l.includes('"id":50'), "cancelled result"));
    expect(cancelled.result).toEqual({ stopReason: "cancelled" });
    expect(c.updates()[1]!.update?.content?.text).toMatch(/^cancelled/);
    expect(await c.close()).toBe(0);
  }, 20_000);

  test("_meta.systemPrompt.append is kept the same as the bare systemPrompt field", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const file = join(t.dir, "deliveries.jsonl");
    const c = client(["acp"], { RELAY_BACKPORT_SINKS: "file", RELAY_BACKPORT_STATE_DIR: t.dir, RELAY_BACKPORT_FILE: file });
    await c.request("initialize", { protocolVersion: 2 });
    const created = await c.request("session/new", { cwd: "/tmp", mcpServers: [], _meta: { systemPrompt: { append: "via meta append" } } });
    const sessionId = (created.result as { sessionId: string }).sessionId;
    await waitFor(() => readFileSync(file, "utf8").includes(`EVENT|session|new|${sessionId}`), 3000, "session lifecycle line");
    const promptPath = join(t.dir, "sessions", `${sessionId}.system-prompt.md`);
    expect(readFileSync(promptPath, "utf8")).toBe("via meta append");
    expect(readFileSync(file, "utf8")).toContain(`EVENT|session|new|${sessionId}|${promptPath}`);
    expect(await c.close()).toBe(0);
  });

  test("file.buzz_env_file: writes the harness-injected BUZZ_* identity on session/new, and never logs the values", async () => {
    const t = tmpDir();
    cleanups.push(t.cleanup);
    const file = join(t.dir, "deliveries.jsonl");
    const envFile = join(t.dir, "buzz.env");
    const key = "nsec1envfilehandofftestvaluethatmustneverbelogged";
    const c = client(["acp"], {
      RELAY_BACKPORT_SINKS: "file",
      RELAY_BACKPORT_STATE_DIR: t.dir,
      RELAY_BACKPORT_FILE: file,
      RELAY_BACKPORT_FILE_BUZZ_ENV_FILE: envFile,
      RELAY_BACKPORT_FILE_SYSTEM_PROMPT: "false",
      RELAY_BACKPORT_LOG_FORMAT: "json",
      BUZZ_PRIVATE_KEY: key,
      BUZZ_RELAY_URL: "wss://relay.example",
      BUZZ_AUTH_TAG: "auth-tag-value",
    });
    await c.request("initialize", { protocolVersion: 2 });
    const created = await c.request("session/new", { cwd: "/tmp", mcpServers: [] });
    const sessionId = (created.result as { sessionId: string }).sessionId;
    await waitFor(() => readFileSync(file, "utf8").includes(`EVENT|session|new|${sessionId}`), 3000, "session lifecycle line");
    await waitFor(() => existsSync(envFile), 3000, "buzz env file");
    expect(readFileSync(envFile, "utf8")).toBe(`BUZZ_RELAY_URL=wss://relay.example\nBUZZ_PRIVATE_KEY=${key}\nBUZZ_AUTH_TAG=auth-tag-value\n`);
    // file.system_prompt=false: no sessions/ prompt file for this run
    expect(existsSync(join(t.dir, "sessions"))).toBe(false);
    expect(await c.close()).toBe(0);
    const err = await c.stderr();
    expect(err).not.toContain(key);
    expect(err).toContain(`wrote buzz env file ${envFile} (3 vars)`);
  });

  test("a config problem exits 1 before speaking ACP", async () => {
    const c = client(["acp"], { RELAY_BACKPORT_SINKS: "stdout" });
    expect(await c.close()).toBe(1);
    expect(await c.stderr()).toContain("unknown sink");
    expect(c.lines).toEqual([]);
  });
});
