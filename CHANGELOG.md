# Changelog

All notable changes to relay-backport. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## 0.5.0 — 2026-09-21

named views on `tail`, and `show` — both off by default

### Added

- **Views.** One stored `MENTION|` record, many per-reader projections. A view never rewrites the file; `tail --view NAME` (or `view.name` in config) prints a shape one kind of consumer can read. Default `raw` is the stored line, unchanged. The first named view is `claude-code`.
- **`claude-code` view.** For each record, two lines in **one write**: a `WAKE` header (type, channel name, scope, thread title, purpose, sender, class, owner, reply anchor, channel uuid, short event id, time, catch-up count by speaker, content length) and a `TEXT` line (short id + message, newlines shown as the ASCII marker ` \n `). Lifecycle `EVENT|` lines pass through. The visible budget is `view.visible_chars` (default 500, minimum 32); the writer enforces every cap so neither line exceeds it. Truncate, never wrap. A message body that starts with `WAKE ` or `TEXT |` stays on the TEXT line and cannot forge a header. Untrusted names cannot carry `[` `]`. The configured owner renders as `[human, owner]`; `owner <name>` is only for an agent's owner. Absent `scope` falls back to a root/reply `e` tag meaning thread. The quoted title is the root message (matched by id), never the first catch-up line; a miss prints `(thread)` with no title.
- **Prompt-header fields on the record**, behind `file.prompt_fields` (default **off**). `parseBuzzPrompt` already received channel name, description, scope, sender display name and the `--reply-to` anchor and discarded them. When the switch is on they are appended last on the JSON (`channel_name`, `channel_description`, `scope`, `sender_name`, `reply_to`, `created_at`). Extra keys, even at the end, change the bytes, so the v0.1 byte-identical promise needs the switch — existing readers that ignore unknown keys still parse.
- **Optional overlay tables.** `[channels]` uuid → purpose string; `[identities]` pubkey → label. Config wins over the stored description / display name. A miss prints `?`. Owner status comes only from `run.owner`, never from text. `view.hide` (and `--hide`) are pubkey prefixes whose catch-up entries are omitted from `thread +N`.
- **`relay-backport show [--last | --id PREFIX] [--hide PREFIX]… [--raw] [--file PATH]`.** Reads only the local deliveries file (the tail of the file; a partial last line is ignored). Prints a header, the full message, then the thread catch-up with hidden authors removed and a count of what was hidden. Refuses an ambiguous id prefix. `--raw` prints the untouched record. Catch-up block parsing (`[n] name (pubkey) (time): body`) is a tested function: a format change degrades to "print everything", never to a crash.
- Cursor semantics of `tail` are unchanged: one file record advances the cursor by one, whatever the view prints.

### Notes

- Nothing about the webhook or exec sinks moves. A second named view is an addition, not a rewrite of the record.
- Default output of `tail` and of the file sink is byte-identical to 0.4.0. Turn the new behaviour on with `tail --view claude-code` / `view.name = "claude-code"` and, to persist the words on the record, `file.prompt_fields = true`.

## 0.4.0 — 2026-09-20

opt-in delivery receipt, default off

### Added

- **Delivery receipt** (`[receipt]`, off by default). When a sink accepts a wake, relay-backport can publish a kind:7 reaction on that event, signed by the harness identity, so the author sees the wake was received even while the consumer is still working. Config: `receipt.enabled`, `receipt.reaction` (default `👀`, any emoji or a `:shortcode:`), `receipt.timeout_ms` (default 4000). Env: `RELAY_BACKPORT_RECEIPT_ENABLED`, `_REACTION`, `_TIMEOUT_MS`.
- At-least-once per event id, persisted in `<state_dir>/receipts.seen` as `pending` then `done`. A pending line is retried once on start; a failed retry becomes `gave_up`. The cap evicts only settled rows, never pending. Newest `receipt.max_seen` settled ids (default 5000). Not published for events no sink accepted, synthetic prompts, events without author and channel, the harness identity's own messages, or when the ledger cannot be written or an existing ledger cannot be read.
- Publish path: a one-shot NIP-01 websocket to `BUZZ_RELAY_URL` (NIP-42 AUTH if challenged, including a late auth-required OK after EVENT: authenticate and resend once). Failure logs one warning and never fails the delivery. The key is read lazily only for the own-message check on an otherwise eligible delivery, and to sign a publish. Signing uses `nostr-tools`, bundled into the compiled binary.

## 0.3.3 — 2026-09-17

**A file-sink consumer could not see the thread it was answering in.** The harness builds a thread's history once per session — turn 1's prompt carries a `<thread-context>` block, every later turn is told the context was already delivered — and the `MENTION|` line carried only the mention itself. A consumer woken by turn 2 therefore had the question and no copy of turn 1 anywhere: the same gap `cumulative` mode closed for the webhook sink in 0.3.0/0.3.1, still open for the file one.

### Added

- **`thread_context` on the `MENTION|` line.** An array of entries, oldest first, in delivery order: `{kind, event_id, at, text, truncated?}`, where `kind: "block"` is a `<thread-context>` (or `<conversation-context>`) block the harness built and `kind: "event"` is a mention already delivered in this session, labelled `[previously delivered mention] from … · … · event …` as the webhook's field labels it. The current turn's own text is never in it — that is already `content`. It is an array rather than the webhook's single joined string because a per-entry `"truncated": true` has nowhere to live inside a string.
- **`file.thread_context`** (`RELAY_BACKPORT_FILE_THREAD_CONTEXT`, CLI `--file-thread-context`), one of:
  - `cumulative` (**the default**) — the whole session ledger on every line, for a consumer that reads only the line it woke on;
  - `new` — only what the ledger gained since the previous `MENTION|` line of that session, for a consumer that reads every line and keeps its own history. The invariant: turn N carries turn N's block (when its prompt had one) plus turn N-1's delivered mention. The window is in memory, so a restart mid-session starts a fresh one;
  - `none` — the 0.3.2 line exactly.
- **`file.thread_context_max_chars`** (`RELAY_BACKPORT_FILE_THREAD_CONTEXT_MAX_CHARS`, CLI `--file-thread-context-max-chars`, default `32000`, `0` = unlimited) bounds the whole block: whole entries are dropped from the **oldest** end — the newest context is the one the consumer most needs, and half an entry is worse than none — and the line carries `"thread_truncated": true` when any were. `file.content_max_chars` additionally caps each entry's `text`, marking that entry `"truncated": true` exactly as it marks `content`.
- **`relay-backport tail --no-thread`** strips `thread_context` and `thread_truncated` from the `MENTION|` lines it prints, for a human watching the wire. Stripping happens in the write path only: the tail still *consumes* every line, so the cursor advances exactly as it does without the flag, and an `EVENT|` line or a `MENTION|` line whose JSON does not parse is printed verbatim rather than dropped.
- **The file sink keeps its own ledger**, `<state_dir>/sessions/<session id>.file-context.jsonl`, next to the webhook's `.context.jsonl`. Separate files on purpose: de-duplication is in memory and per ledger instance, so two sinks appending to one file would write every entry twice and double the history a restart reads back. Same format, same 0600, same tolerance — an unparsable line is skipped, a failed write is swallowed, and neither is ever a delivery failure.

### Changed

- **The default output of the `file` sink changes.** From turn 2 of a session onward its lines carry the new field, so they are no longer byte-identical to 0.3.2. Every field that line has ever had keeps its name, its value and its position — `thread_context` and `thread_truncated` are appended last, and are absent entirely when there is nothing to carry (turn 1 of a session, for instance) — so a consumer that ignores unknown keys is unaffected. **`file.thread_context = "none"` restores the old line exactly.**
- Nothing else moves: `EVENT|` lifecycle lines, the cursor, the system-prompt and buzz-env files, the webhook and exec sinks, `thread_context_cumulative` and every existing config key behave as in 0.3.2.

### Notes

- The two sinks deliberately use different mode names — `file.thread_context = none | new | cumulative` against `webhook.thread_context = delta | cumulative`. A webhook receives one POST and nothing else, so its choice is "the delta the harness built" or "everything"; a file consumer reads a stream of lines, where "only what is new since the last line" is a third, useful answer.

## 0.3.2 — 2026-09-17

**The `MENTION|` line was silently eating the end of long messages.** `content` had been capped at a fixed 400 characters since v0.1, when that line was a human-readable preview printed to stdout. It is now the delivery channel into a terminal session: a message longer than the cap arrived with its tail cut off, with nothing on the line to say so, so a consumer could not tell a short message from a clipped one. A dictated instruction whose last sentence fell past character 400 was simply never seen.

### Changed

- **`content` is delivered whole by default.** The cap is now `file.content_max_chars` (env `RELAY_BACKPORT_FILE_CONTENT_MAX_CHARS`, CLI `--file-content-max-chars N`), default `0` = unlimited. Set it to a positive integer to cap as before — `400` reproduces 0.3.1's behaviour exactly.
- **A cap that actually truncates adds `"truncated": true`** to the JSON on the line, after `rootId`. When nothing is truncated the field is absent and the line is byte-identical to every version since v0.1 — same fields, same order — so an existing consumer keeps parsing it unchanged.
- **`MENTION_CONTENT_MAX` is gone** from the library surface; the value is a config key now, not a constant.
- Nothing else moves: the `EVENT|` lifecycle lines, `tail` (whose reader never assumed a maximum line length), the webhook and exec sinks, and every other config key are untouched.

## 0.3.1 — 2026-09-17

**Cumulative thread context was still missing half the thread.** 0.3.0 accumulated the `<thread-context>` blocks the harness sends and nothing else — but the harness withholds an already-delivered *mention* exactly as it withholds already-delivered context. Turn 2 of a thread therefore arrived at a stateless receiver with the prose note, the new mention, and no copy of turn 1's own text anywhere in the payload. Found on a live receiver: mention A "remember the word HARBOR", mention B "what word?" in the same thread — B's `thread_context_cumulative` had no HARBOR in it, and the receiver answered with a word nobody had said.

### Fixed

- **`cumulative` mode now also records the mentions it delivered.** For every delivery the per-session ledger keeps, in delivery order, both the `<thread-context>` block the prompt carried (as before) and the event that was delivered — author, `created_at`, event id and the message text as the prompt's `<buzz-event>` carried it. `thread_context_cumulative` for turn N is therefore every context block seen so far *plus* the mentions of turns 1..N-1, interleaved by delivery order, under the same `webhook.cumulative_max_chars` bound (oldest entries dropped whole from the front, `thread_context_truncated: true` when they are).
- **The current turn's own mention is never in the field.** It is already in `prompt` and `text`; repeating it would cost tokens to say the same thing twice. Delivery is at-least-once, so the exclusion is by event id rather than by ordering — a redelivered turn still excludes itself.
- **The receiver's own replies are not in it either.** relay-backport never sees them; they appear only if the harness folds them into a later `<thread-context>` block, which is the harness's call to make.
- **A delivered mention is labelled** — `[previously delivered mention] from <pubkey> · <ISO time> · event <id>`, then the text. A later thread-context block usually repeats the same message, and that duplication is the safe failure mode only if a model reading the field can tell "a mention I was already sent" from "history the harness built".

### Changed

- **Ledger lines carry `kind: "block" | "event"`.** Reads are backward compatible: a line written by 0.3.0 has no `kind` and loads as a block, so an existing `<state_dir>/sessions/<sid>.context.jsonl` keeps working across the upgrade without migration. De-duplication is now on `(kind, event_id)` rather than `event_id` alone — one turn contributes up to two lines under the same event id, while a retry of that turn still contributes neither.
- Nothing outside `cumulative` mode moves. `delta` is still the default and still byte-identical to 0.2.x, `prompt` is still exactly what the harness built, the `file` and `exec` sinks are untouched, and no config key, CLI flag or `MENTION|` line changes.

## 0.3.0 — 2026-09-17

**Two shapes, both of them now supported end to end: a terminal session that tails a file, and a webhook that keeps no state.** 0.2.x shipped the pieces; 0.3 closes the gaps that stopped either shape working unattended. The terminal shape lost mentions on every restart — the tail now carries a cursor. Running the harness headlessly meant an operator-maintained shell script per machine — `run` absorbs it. And a webhook received a thread's history exactly once, then deltas forever — `cumulative` mode keeps the ledger a stateless receiver cannot.

### Added

- **`relay-backport run [--config PATH] [--dry-run] [--observe]`** — the launcher, absorbing the per-machine shell script that headless operation previously required. It resolves `buzz-acp` (`run.buzz_acp`, `$BUZZ_ACP_BIN`, or `buzz-acp` on `PATH`), builds its whole environment from a `[run]` config section, preflights, prints the plan, and runs it in the foreground with signals forwarded to the child.
- **The key reaches `BUZZ_PRIVATE_KEY` and nothing else.** Never an argument vector (`ps` is world-readable on most boxes), never a log line, never the printed plan — which names the key's *file* and its *byte count*. `--dry-run` never reads the bytes at all; it stats the file for a size. The value is registered with the log redactor the instant it is read.
- **`[run]` config**: `buzz_acp`, `key_file`, `relay_url`, `owner`, `allowlist` (list), `allowlist_file` (the JSON store `{ "entries": [{ "pubkey": "…" }] }`, merged into the list, de-duplicated, config order first), `session_title` (default `relay-backport-ears`), `session_policy` (default `thread`), `self` (override `BUZZ_ACP_AGENT_COMMAND`), `observe_page_url` / `observe_ingest_url`. Each has a `RELAY_BACKPORT_RUN_*` environment variable.
- The child gets `--session-title … --no-memory --lazy-pool --no-typing --multiple-event-handling queue`, and `BUZZ_ACP_AGENT_ARGS=acp,--state-dir,…,--sink,…`. `queue` rather than the `steer` default: steering cancels an in-flight turn and re-dispatches a merged prompt, which for a file sink duplicates the mention. The state dir and sink list are passed **both** as `RELAY_BACKPORT_*` env and as flags in `BUZZ_ACP_AGENT_ARGS` (which win), so an env-scrubbing harness still lands deliveries in the right file.
- **`--observe`** adds the `webhook` sink to the child and points `RELAY_BACKPORT_WEBHOOK_URL` at the local observe page's `/ingest`, failing the preflight when the page is not up. The probe is a `GET` of the page root, not of `/ingest`, which is POST-only.
- **Preflight** (`OK` / `WARN` / `FAIL`; any `FAIL` means nothing starts): binary resolves, key file present with mode 0600 and a plausible size, allowlist non-empty, state dir writable or creatable, no other harness under the same `--session-title`, and the observe page under `--observe`. A relay that does not answer its NIP-11 probe is a **`WARN`**, not a `FAIL` — `buzz-acp` dials and retries the websocket itself, so refusing to start over one blipped HTTPS probe would be the worse bug. The duplicate-title check needs `pgrep`, so it degrades to a `WARN` where that cannot be asked (Windows).
- **`relay-backport tail` keeps a persistent line cursor** (`<state_dir>/tail.cursor`, `--cursor PATH` to move it): the number of lines it has handed to its consumer, advanced after every line and written atomically (temp file + rename, so a crash mid-write leaves the previous value rather than a truncated one). On start the tail resumes from that number instead of from the end of the file, printing `EVENT|catchup|N line(s) written while the tail was down` before it replays the gap. A cursor that is missing, empty or unparsable reads as `0` — an untrustworthy cursor replays rather than skips.
- Rotation and truncation are detected two ways: fewer lines in the file than the cursor claims (when the tail places itself against it), and a changed inode or a shrunken size (while following). Either replays from the top. A file that merely goes **missing** — `stat` fails for a transient permission or filesystem error as readily as for a delete — never zeroes the cursor: when it comes back, the tail places itself against the cursor again, so an unchanged file replays nothing and only a genuinely shorter one starts over.
- **`webhook.thread_context = "delta" | "cumulative"`** (`RELAY_BACKPORT_WEBHOOK_THREAD_CONTEXT`, default `delta`) and **`webhook.cumulative_max_chars`** (`RELAY_BACKPORT_WEBHOOK_CUMULATIVE_MAX_CHARS`, default `32000`). In `cumulative` mode every POST carries a new field, **`thread_context_cumulative`**: every `<thread-context>` (or `<conversation-context>`) block the ACP session has seen, oldest first, including the current turn's. Over the bound, whole blocks are dropped from the oldest end and the payload carries `thread_context_truncated: true`.
- The reason it is needed: `buzz-acp` builds a thread's history **once per session** — the first prompt of a thread carries the block, and every later prompt in that session says instead that "Earlier thread context was already delivered in this session". Correct for a long-lived agent process; wrong for a stateless webhook, which then gets the history on request one and a bare delta forever after. relay-backport keeps the ledger the receiver does not have.
- The per-session ledger is in memory and appended to `<state_dir>/sessions/<session id>.context.jsonl` (0600, one JSON object per line, de-duplicated on `event_id` so a retry is not recorded twice), so a relay-backport restart inside a live session keeps what it already forwarded. A ledger that cannot be read or written is never a delivery failure: an unparsable line is skipped, a failed write is swallowed, and the POST goes out regardless.
- The context block is parsed with the same outermost-span rule as the event framing, so a forged `</thread-context>` inside a message body cannot truncate the real block.

### Changed

- **The cursor is ON by default, which changes what a fresh `tail` prints.** Before 0.3 a tail started at the end of the file and showed only what arrived next; from 0.3 a tail with no cursor file replays everything already in the file, then follows. This is the point — a Monitor or supervisor restart used to silently drop every mention delivered during the gap. **`--no-cursor` restores the old behaviour exactly**, and is the only mode in which `--lines N` applies; `--lines` with a cursor is a usage error rather than a silently ignored flag, and so is `--cursor` together with `--no-cursor`.

### Notes

- README rewritten around the two shapes: **(A) a Claude Code interactive terminal session** — `run`, the `file` sink, `tail` with its cursor, the one-line Monitor command, what a `MENTION|` line looks like, how gap replay works, the observe page; and **(B) a webhook agent (stateless receiver)** — the payload fields, when to turn `include_system_prompt` off, cumulative thread context, and a minimal receiver. The reference sections (configuration table, sinks, architecture, security) are unchanged.
- No sink, payload, config-file key or `MENTION|` line change to any existing path; `run` is additive, and `acp`, `tail` and `observe` behave exactly as in 0.2.2.
- `run` reads one unprefixed variable, `BUZZ_ACP_BIN` — Buzz's own name for it. Every other setting it owns is `RELAY_BACKPORT_RUN_*`.
- No sink, payload, config-file key or `MENTION|` line changes. The cursor is a `tail` concern only: the `acp` path, the file sink's format and every consumer of it are untouched, and a consumer that never restarts sees no difference.
- **A new field, not a rewritten prompt.** `prompt` stays exactly what the harness built — it is what the observe page renders verbatim and derives its per-session token estimate from, and prepending history there would double-count it. In the default `delta` mode the payload is byte-identical to 0.2.x, the field simply absent.
- Webhook-scoped: the `exec` sink shares the payload builder but is unchanged, and gets no `exec.thread_context` key until something asks for one.

## 0.2.2 — 2026-09-16

**`relay-backport observe`: a loopback page showing what the agent sees.**

Context engineering is hard to do blind. The harness builds a prompt, hands it over, and after that the material is invisible — the `file` sink caps content at 400 characters and the `webhook` sink POSTs it into someone else's server. `observe` renders it: the full prompt as built, the standing system prompt, and a per-session token estimate so the growth of the window across a thread is something you can look at.

### Added

- **`relay-backport observe [--port N] [--buffer N] [--bind ADDR]`** (default `127.0.0.1:7479`, buffer 200): serves one self-contained HTML page at `/` — no external script, stylesheet, font or CDN, and the only connection it opens is its own SSE stream at `/events` — plus `POST /ingest`, which takes the `webhook` sink's JSON payload unchanged. A body that is not a delivery is `400` and never consumes a sequence number. `GET /records` and `GET /sessions` expose the same data as JSON. Loopback only, no authentication, no persistence.
- The page shows each delivery as a two-column card, newest first: **left** the relay event (kind, id, thread root, `event_source`, content, tags), **right** what the agent would see — the full prompt verbatim, the session's system prompt when the sink attached one, and a Buzz identity block (relay, session id, cwd, title, sender, channel), each collapsible with a byte count and an approximate token count (`chars / 4`) in its summary line.
- A **session context** sidebar: one row per ACP session with a cumulative token estimate. The standing system prompt is counted **once per session** (again only if its text changes), not once per turn — the harness sends it on `session/new` only, and the webhook sink re-attaches it to every POST, so per-turn counting would overstate a session by 20-40 KB per turn. Totals are kept server-side and survive ring-buffer eviction.
- README: an "Observe: see what the agent sees" section with the Buzz Desktop custom-harness `env` example (`RELAY_BACKPORT_SINKS=file,webhook`, `RELAY_BACKPORT_WEBHOOK_URL=http://127.0.0.1:7479/ingest`) and the note that the page shows only what the harness accepted — the respond-to gate is upstream and invisible here. A security note on the one command that listens on a socket.

### Security

- `/ingest` caps a request body at **1 MiB** (`413` over it), counted as the body streams so a chunked POST that declares no `content-length` is capped too; an oversized body is drained and discarded rather than cancelled, so the sender's next delivery on the same keep-alive connection still parses. Without the cap a single POST could be held in full in the ring buffer.
- `--bind` to a non-loopback address logs a warning at startup. The page has no authentication and serves every prompt verbatim.

### Notes

- No sink, payload, config key or `MENTION|` line changes: `observe` is a consumer of the existing `webhook` sink, and the `acp` path never starts it.
- Ported from the v0.1 observe tap (ring buffer, SSE replay, `/ingest`) without its relay-socket half — v0.2 has no watch daemon, so there are no verdicts and no second lane: everything the page shows was, by definition, accepted.

## 0.2.1 — 2026-09-06

**Zero-setup consumer handoff: the standing system prompt and the agent's own Buzz identity now reach every consumer, not just the per-turn prompt.**

`buzz-acp` sends the whole standing context (Buzz conventions, mention/threading etiquette, memory protocol) once, on `session/new`, as the bare `systemPrompt` field (or `_meta.systemPrompt.append` for a `claude-agent-acp`-shaped client) — and relay-backport was throwing it away, keeping only its character count. A consumer with no Buzz integration got the per-turn delta but never the conventions that make it actionable, and a file-sink consumer had no way to act as the agent at all (no key, no relay URL). Both gaps close in this release; nothing about the per-turn `MENTION|` line, the webhook payload shape, or the exec hook's existing environment changes.

### Added

- `session/new` now advertises one model, `passthrough` ("Forwards each mention to the configured sinks; no LLM.") in the unstable `SessionModelState` (`models: { currentModelId, availableModels }`) — without it, a Buzz harness's model picker reported "relay-backport reported no models". `session/set_model` is answered too (there is only one model, so it always "succeeds" back onto it).
- **The `session/new` system prompt is kept and forwarded, verbatim, instead of being discarded after its length is logged.** It never appears in a log line — only its character count does.
- **`file` sink**: on `session/new`, writes the system prompt once to `<state_dir>/sessions/<session id>.system-prompt.md` (0600, atomic write) and extends the `EVENT|session|new|<id>` lifecycle line with the file's absolute path — `EVENT|session|new|<id>|<path>` — when it wrote one. A consumer that only ever saw `EVENT|session|new|<id>` keeps working unchanged. New config: `file.system_prompt` (`RELAY_BACKPORT_FILE_SYSTEM_PROMPT`, default `true`).
- **`file.buzz_env_file`** (`RELAY_BACKPORT_FILE_BUZZ_ENV_FILE`, default unset): when set, (re)writes the harness-injected `BUZZ_RELAY_URL` / `BUZZ_PRIVATE_KEY` / `BUZZ_AUTH_TAG` — whichever are present — as `KEY=value` lines to that path (0600, atomic) on every `session/new`. This is the agent's own private key; it exists so a terminal session sitting next to the delivery file can `source` it and use the `buzz` CLI as the agent. Off by default. The log line names only the path and how many variables were written, never a value.
- **`webhook` sink**: every POST now carries `system_prompt` (the session's system prompt, verbatim) when the session had one. New config: `webhook.include_system_prompt` (`RELAY_BACKPORT_WEBHOOK_INCLUDE_SYSTEM_PROMPT`, default `true`). Adds roughly 20-40 KB to the request body.
- **`exec` sink**: the hook's stdin JSON gains `system_prompt` when `exec.include_system_prompt` (`RELAY_BACKPORT_EXEC_INCLUDE_SYSTEM_PROMPT`, default `false`) is on.
- README: a "What the consumer receives" section, the new config rows, the Buzz Desktop DM caveat (Desktop p-tags every DM participant on every message, so a DM fires a prompt per message even with no `@mention`), and a note on why the system prompt is forwarded verbatim rather than reshaped.

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
