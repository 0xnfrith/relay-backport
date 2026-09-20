# Architecture

`architecture.png` / `architecture.svg` in this directory are the hand-drawn (Excalidraw) export of the **v0.2** diagram — the Buzz harness (`buzz-acp`, Desktop-managed or headless) spawning `relay-backport acp` over stdio, which delivers to the `file` / `webhook` / `exec` sinks. The Mermaid in the README and the sequence view below stay the always-rendering reference; the export is the polished, hand-arranged version.

## Data flow

Buzz's harness (`buzz-acp`, inside Buzz Desktop or headless) is the ACP client. It owns the relay socket and the key, discovers channels, applies the respond-to gate, resolves the session scope and fetches thread context; relay-backport only receives each prompt and delivers it.

```mermaid
sequenceDiagram
  autonumber
  participant R as Buzz relay
  participant H as buzz-acp (harness)
  participant A as relay-backport acp
  participant S as sinks
  participant C as consumer

  H->>A: spawn (env: BUZZ_RELAY_URL, BUZZ_PRIVATE_KEY, BUZZ_AUTH_TAG, RELAY_BACKPORT_*)
  H->>A: initialize {protocolVersion}
  A-->>H: {protocolVersion, agentCapabilities, authMethods: []}
  H->>A: session/new {cwd, mcpServers, systemPrompt | _meta.systemPrompt.append, _meta.sessionTitle}
  A->>S: EVENT|session|new|<id>  (file sink)
  A-->>H: {sessionId}
  loop every mention the harness admits
    R-->>H: EVENT (mention of the agent)
    H->>H: gate · scope · context · memory · prompt framing
    H->>A: session/prompt {sessionId, prompt: [{type: text}], _meta.buzz.events?}
    A->>A: event ← _meta.buzz.events | <buzz-event> text | synthetic
    A->>S: deliver(record)  — all sinks at once, bounded by delivery_wait_ms
    S->>C: MENTION|json (file → tail) / POST / stdin JSON
    A-->>H: session/update agent_message_chunk "delivered to N sinks"
    A-->>H: {stopReason: end_turn}
    opt receipt.enabled (off by default)
      A->>R: kind:7 on the wake (one-shot websocket; never blocks the turn)
    end
    C-->>R: reply with its own tooling
  end
  opt Stop pressed mid-turn
    H->>A: session/cancel {sessionId} (notification)
    A->>S: EVENT|session|cancel|<id>
    A-->>H: {stopReason: cancelled}
  end
  H->>A: close stdin
  A->>S: EVENT|acp|closed
  A-->>H: exit 0
```

## Components

| Component | File | Responsibility |
|---|---|---|
| cli | `src/cli.ts` | `acp` (default) and `tail` subcommands, flags, exit codes |
| config | `src/config.ts` | `RELAY_BACKPORT_*` env + TOML/JSON file + flags; registers Buzz-injected secrets with the redactor |
| acp server | `src/acp-server.ts` | JSON-RPC over stdio: initialize / authenticate / session/new / session/prompt / session/cancel, bounded delivery wait, honest acknowledgement, lifecycle events |
| prompt | `src/prompt.ts` | prompt text → event: `_meta.buzz.events[]`, the `<buzz-event>` text framing, or a synthetic event |
| delivery | `src/delivery.ts` | the record sinks receive; the `MENTION\|` line (v0.1 shape); the webhook/exec JSON payload |
| sinks | `src/sinks/{file,webhook,exec}.ts` | append to the delivery file (+ `EVENT\|` lines); JSON POST with retry; one process per delivery with a minimal environment |
| receipt | `src/receipt.ts` | optional kind:7 on a wake a sink accepted; one-shot NIP-01 publish; once-only ledger |
| tail | `src/tail.ts` | `tail -F` for the delivery file: follows appends, truncation, rotation, late creation |
| log | `src/log.ts` | stderr logger with secret redaction |

## Files

```
<state dir>/                 ~/.local/state/relay-backport (XDG_STATE_HOME honoured) · %LOCALAPPDATA%\relay-backport
  deliveries.jsonl           one MENTION|{json} per delivery + EVENT|session|new|<id> · EVENT|session|cancel|<id> · EVENT|acp|closed
                             0600, directory 0700, every line a single O_APPEND write
  receipts.seen              `pending <id> <author> <channel> <kind>` then `done <id>`; compacted to newest max_seen ids; only when receipts are enabled
  tail.cursor                lines `tail` has already handed over
  sessions/<id>.*.jsonl      per-sink thread-context ledgers
```

The harness still owns the long-lived relay socket and the key. Receipts borrow the injected key for a one-shot publish and do not keep it on disk.
