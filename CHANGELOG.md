# Changelog

All notable changes to relay-backport. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## 0.2.0 — 2026-09-05

**Re-architected as a Buzz ACP harness; the standalone relay daemon is removed (last release with it: v0.1.x).**

Buzz's own harness, `buzz-acp` (Apache-2.0, bundled in Buzz Desktop and runnable headless), already implements the relay layer — websocket, NIP-42 auth, channel discovery, the "who can send instructions" gate, session scope, thread context, core memory, reactions — and its context engineering. v0.1 reimplemented that layer; keeping two alive was duplicated effort with a maintenance tail. v0.2 keeps only what `buzz-acp` does not do: delivery to tools that cannot speak ACP.

### Added

- **`relay-backport acp`** (the default command, so a Buzz Desktop custom-harness entry can be just `"command": "relay-backport"`): an ACP server over stdio. Answers `initialize` (protocol version echoed up to 2, no auth methods, text prompts only), `authenticate`, `session/new`, `session/prompt`, `session/cancel`; unknown methods → `-32601`, unknown session → `-32602`, unparsable line → `-32700`. Every prompt is forwarded, whole, to the configured sinks; one `agent_message_chunk` acknowledges delivery ("delivered to N sinks", honest about failures and about a `delivery_wait_ms` timeout) and the turn ends with `stopReason: end_turn` (`cancelled` when a cancel lands mid-turn). Exits 0 when the harness closes stdin.
- **Event resolution**: `_meta.buzz.events[]` when the harness sends it (the structured shape in flight upstream; the last event routes), else the harness's `<buzz-event>` text framing (`Event ID`, `Channel`, `Kind`, `From … (hex: …)`, `Time`, `Content`, `Tags`; the last block of a `<buzz-events>` batch), else a synthetic event with a stable sha256 id, sender `unknown` and the raw prompt as content.
- **`file` sink** (default): appends one `MENTION|{json}` line per delivery — the v0.1 stdout shape, unchanged: `kind, from (8 hex | "unknown"), h, content[0:400], id, tags, rootId?` — plus `EVENT|session|new|<id>`, `EVENT|session|cancel|<id>`, `EVENT|acp|closed`, to `<state dir>/deliveries.jsonl` (0600, single O_APPEND writes).
- **`relay-backport tail [--file] [--lines N] [--no-follow]`**: a `tail -F` for that file, so a Claude Code Monitor tool runs it unchanged; follows appends, truncation, rotation and late creation.
- **`exec.pass_buzz_env`** (`RELAY_BACKPORT_EXEC_PASS_BUZZ_ENV`): hand the harness-injected `BUZZ_*` identity (and `NOSTR_PRIVATE_KEY`) to the hook so it can reply with the `buzz` CLI. Off by default.
- `RELAY_BACKPORT_*` environment prefix for every setting; `delivery_wait_ms`; a platform per-user default state directory.
- Docs: Buzz Desktop 60-second setup, headless `buzz-acp` setup (`BUZZ_ACP_AGENT_COMMAND` / `BUZZ_ACP_AGENT_ARGS`), "what changed from v0.1 and why".

### Changed

- The webhook / exec payload is now `{ source, transport: "acp", relay, channel, event_id, thread_root, reply_to, root_id?, author, kind, created_at, text, tags, event_source, prompt, session, events? }`. The v0.1 `mention {ptag, text, from_owner, allowed_by}` block is gone (the harness gates; relay-backport cannot know why a prompt was admitted); `prompt`, `session` and `event_source` are new.
- The exec hook's stdout is routed to relay-backport's stderr (stdout is the ACP stream) and its environment gains `RELAY_BACKPORT_SESSION_ID`.
- `BUZZ_RELAY_URL` (as injected by the harness) fills the payload's `relay`.
- The Docker image runs `acp` by default and is the building block for a headless pod that also runs `buzz-acp`.

### Removed

- The `watch` daemon and everything only it needed: the relay client (websocket, NIP-42, subscriptions, discovery, replay window, cursor), mention matching, the allowlist and its HMAC signing, the control channel and `allow`/`status`/`reload`/`stop` commands, the health endpoint, reactions, `seen.txt` / `cursor.txt` / `allowlist.json` / `signing.key` / `control.*`, the systemd unit, the `stdout` sink (replaced by `file` + `tail`), the `acp` sink scaffold, the `RELAY_URL` / `PRIVATE_KEY_FILE` / `OWNER_PUBKEY` / … settings, exit codes 2–4.

### Unverified

- The Buzz Desktop custom-harness dialog and spawn path were not exercised — the ACP flow is covered by tests against an in-process client that sends what `buzz-acp` sends, and `_meta.buzz.events[]` follows the shape in flight upstream.

## 0.1.0 — 2026-09-05

Initial release: the standalone `watch` daemon (NIP-42 auth, discovery, one `REQ` per channel, mention matching, dedup + replay window, signed allowlist, control channel, health endpoint, reactions), the `stdout` / `webhook` / `exec` sinks and an `acp` sink scaffold, release binaries for Linux, macOS and Windows, Docker and systemd deploy files.
