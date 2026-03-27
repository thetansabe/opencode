# OpenCode Architecture

This document explains three key aspects of how OpenCode works internally:

1. **Session storage** – how conversations are persisted to disk
2. **Token compaction** – how the context window is managed automatically
3. **Custom-app integration** – how to embed OpenCode in your own application

---

## 1. Session Storage

### Database

All persistent data lives in a single **SQLite** file managed by [Drizzle ORM](https://orm.drizzle.team/).

| Path (default) | Description |
|---|---|
| `~/.local/share/opencode/opencode.db` (Linux) | Session data for the `latest` release channel |
| `~/Library/Application Support/opencode/opencode.db` (macOS) | Same on macOS |
| Override with `OPENCODE_DB=path` env var | Absolute path, or `:memory:` for tests |

SQLite is opened with WAL mode, `NORMAL` synchronous writes, a 5 s busy timeout, and a 64 MB page cache. Schema migrations are applied automatically at startup.

### Schema

Four Drizzle tables live in `packages/opencode/src/session/session.sql.ts`:

```
SessionTable     – one row per conversation
MessageTable     – one row per turn (user or assistant)
PartTable        – one row per content block inside a message
TodoTable        – task list attached to a session
```

**`SessionTable`** columns of interest:

| Column | Purpose |
|---|---|
| `id` | ULID – lexicographically sortable unique id |
| `project_id` | ties the session to a project (git root or cwd) |
| `parent_id` | if set, this is a child/forked session |
| `title` | auto-generated or user-set title |
| `time_compacting` | timestamp set while compaction is running |
| `time_archived` | timestamp when the session is soft-deleted |
| `summary_*` | diff stats (additions, deletions, files changed) |
| `share_url` | public share URL when sharing is enabled |

**`MessageTable`** stores metadata as a JSON blob in its `data` column.  A message is either a **user** turn or an **assistant** turn.  The `data` JSON matches the `MessageV2.Assistant` / `MessageV2.User` types from `message-v2.ts`:

```ts
// User message info fields
{
  role: "user",
  model: { providerID, modelID },
  agent: string,
  time: { created: number }
}

// Assistant message info fields
{
  role: "assistant",
  providerID, modelID,
  tokens: { input, output, reasoning, cache: { read, write }, total },
  error?: { … },
  finish?: "stop" | "error" | "length"
}
```

**`PartTable`** stores each content block of a message.  The `data` column holds a JSON object whose `type` discriminant determines which fields are present:

| Part type | What it contains |
|---|---|
| `text` | Markdown text |
| `tool` | A tool call – name, args, state (pending → running → completed/error), output |
| `file` | A file attachment – MIME type, base64 data-URL |
| `reasoning` | Model's chain-of-thought text |
| `snapshot` | Git snapshot id before edits |
| `patch` | Unified diff of edits made |
| `compaction` | Marker that this message triggers compaction |
| `step-start` / `step-finish` | Agentic loop iteration boundaries with token accounting |

### Reading back a session

```ts
// packages/opencode/src/session/index.ts
const messages = await Session.messages({ sessionID })
// returns MessageV2.WithParts[] – each element is:
// { info: MessageV2.User | MessageV2.Assistant, parts: MessageV2.Part[] }
```

Messages are returned oldest-first and fully hydrated from `MessageTable` + `PartTable`.

---

## 2. Token Compaction

Compaction is the mechanism that lets a session run indefinitely even though LLMs have a finite context window.  The code lives in `packages/opencode/src/session/compaction.ts`.

### When does compaction trigger?

After every assistant reply, `SessionCompaction.isOverflow()` checks whether the tokens used in that turn are close to the model's usable context:

```
usable = model.limit.input − reserved
       (or model.limit.context − maxOutputTokens when no explicit input limit)

reserved = min(20_000, maxOutputTokens(model))   ← default, configurable
```

If `tokens_used ≥ usable` the session is over its budget and compaction runs.

Auto-compaction can be disabled:

```jsonc
// opencode.json
{
  "compaction": {
    "auto": false,       // never auto-compact
    "prune": false,      // disable output pruning (see below)
    "reserved": 10000    // custom buffer in tokens
  }
}
```

### Step 1 – Prune old tool outputs

Before generating a summary, `SessionCompaction.prune()` scans backwards through the message history and **erases the output** of old, stale tool calls while keeping the most recent 40 000 tokens of tool history:

```
PRUNE_PROTECT = 40 000   # keep this many tokens of recent tool outputs
PRUNE_MINIMUM = 20 000   # only prune if there is at least this much to gain
```

The `skill` tool (sub-agents) is exempted from pruning.  Pruned parts are not deleted from the database; their `time.compacted` timestamp is set and the output is omitted when building LLM message arrays.

### Step 2 – Generate a summary

A dedicated **compaction agent** is invoked (`agent: "compaction"`).  By default it uses the same model as the user was chatting with.  You can override it:

```jsonc
// opencode.json
{
  "agent": {
    "compaction": {
      "model": "anthropic/claude-haiku-4-5"
    }
  }
}
```

The agent is given the full (stripped) conversation and asked to produce a structured summary.
The default template has five sections: **Goal**, **Instructions**, **Discoveries**, **Accomplished**, and **Relevant files / directories**.

The summary is stored as an assistant message whose `info.summary = true` flag marks it as a compaction boundary.

Plugins can inject additional context or completely replace the compaction prompt:

```ts
// via opencode plugin
export function onEvent(event, ctx) {
  if (event.type === "experimental.session.compacting") {
    event.context.push("Also remember: …")
    // OR event.prompt = "My custom summary instructions"
  }
}
```

### Step 3 – Replay or continue

After the summary is written, compaction either:

- **Replays the last user message** (when overflow was caused by a single huge turn) – so the agent can try again against a clean, summarised context.
- **Injects a synthetic "continue" message** – so the agent picks up where it left off without repeating the original request.

A `session.compacted` event is published on the Bus when the process finishes.

### Visual flow

```
User sends message
        │
        ▼
  LLM responds
        │
        ▼
 isOverflow(tokens, model)?
    No ──► done
    Yes
        │
        ▼
   prune() ──── mark stale tool outputs as compacted
        │
        ▼
  create compaction user-message in DB
        │
        ▼
  compaction agent generates summary
        │
        ▼
  replay or synthetic-continue user-message inserted
        │
        ▼
  Bus publishes session.compacted
        │
        ▼
  agent loop resumes with fresh context
```

---

## 3. Integrating a Custom Application

OpenCode exposes two integration surfaces:

| Surface | Best for |
|---|---|
| **HTTP/SSE REST API** | any language, any runtime |
| **JavaScript SDK** (`@opencode-ai/sdk`) | Node.js / Bun apps |

### 3.1 HTTP API

Start the server:

```bash
opencode serve --hostname 127.0.0.1 --port 4096
```

The server is a [Hono](https://hono.dev/) app with full OpenAPI documentation available at `GET /openapi.json`.

#### Core session endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/session` | Create a new session |
| `GET` | `/session` | List sessions (filterable by directory, search, timestamp) |
| `GET` | `/session/:id` | Get one session |
| `DELETE` | `/session/:id` | Delete a session |
| `PATCH` | `/session/:id` | Update title / permissions |
| `POST` | `/session/:id/init` | Initialise a session with a directory |
| `POST` | `/session/:id/fork` | Fork a session |
| `POST` | `/session/:id/abort` | Abort the running turn |
| `GET` | `/session/:id/messages` | List all messages + parts |
| `GET` | `/session/:id/message/:msgId` | Get one message |

#### Sending prompts

**Synchronous** – blocks until the agent finishes, streams the result as JSON:

```
POST /session/:id/prompt
Content-Type: application/json

{
  "parts": [{ "type": "text", "text": "Explain this codebase" }],
  "model": { "providerID": "anthropic", "modelID": "claude-sonnet-4" }
}
```

Returns `{ info: AssistantMessage, parts: Part[] }`.

**Asynchronous** – returns `204` immediately; subscribe to the SSE stream for updates:

```
POST /session/:id/prompt_async
```

#### Real-time event stream

Connect once and receive all events for the life of the server:

```
GET /event
Accept: text/event-stream
```

Each event is a JSON line: `{ "type": "event.type", "properties": { … } }`.

Useful events:

| Event type | When it fires |
|---|---|
| `session.created` | A new session is created |
| `session.updated` | Session metadata changes |
| `message.updated` | A message's metadata (tokens, finish reason) changes |
| `message.part.updated` | A part is added or updated (stream new text, tool results, …) |
| `session.compacted` | Compaction finished for a session |
| `session.error` | An error occurred in a background prompt |
| `server.connected` | Sent once on initial connection |
| `server.heartbeat` | Sent every 10 s to keep the connection alive |
| `server.instance.disposed` | A project instance was shut down |

#### Authentication (optional)

Set `OPENCODE_SERVER_PASSWORD` to require HTTP Basic Auth on every request.

#### Directory scoping

Pass `x-opencode-directory` (URL-encoded) as a request header, or include `directory` as a query param, to scope all operations to a specific project root.

---

### 3.2 JavaScript SDK

```bash
npm install @opencode-ai/sdk
```

#### Start the server from code

```ts
import { createOpencodeServer, createOpencodeClient } from "@opencode-ai/sdk"

// Spawns `opencode serve` as a child process, waits for it to be ready
const server = await createOpencodeServer({ port: 4096 })
const client = createOpencodeClient({ baseUrl: server.url })

// Later …
server.close()
```

#### Or connect to an already-running server

```ts
const client = createOpencodeClient({ baseUrl: "http://127.0.0.1:4096" })
```

#### Typical workflow

```ts
// 1. Create a session (tied to a project directory)
const session = await client.session.create({ directory: "/path/to/project" })

// 2. Send a prompt
const result = await client.session.prompt(session.id, {
  parts: [{ type: "text", text: "What does this file do?" }],
  model: { providerID: "openai", modelID: "gpt-4.1" },
})
console.log(result.parts.filter(p => p.type === "text"))

// 3. Send async prompt + subscribe to events for streaming updates
await client.session.promptAsync(session.id, {
  parts: [{ type: "text", text: "Refactor the auth module" }],
})

const events = client.event.subscribe()   // SSE stream
for await (const event of events) {
  if (event.type === "message.part.updated") {
    // stream new text to your UI
  }
  if (event.type === "session.compacted") {
    // context was compacted, the agent is continuing
  }
}

// 4. Read back the full message history
const messages = await client.session.messages(session.id)
```

#### Launching the TUI from code

```ts
import { createOpencodeTui } from "@opencode-ai/sdk"

const tui = createOpencodeTui({
  project: "/path/to/project",
  model: "anthropic/claude-sonnet-4",
  session: session.id,   // optional – resume an existing session
})
// tui.close() to stop it
```

---

### 3.3 Agent Client Protocol (ACP)

For deeper, bidirectional integration (e.g. embedding OpenCode in an IDE or custom shell), OpenCode also speaks the **Agent Client Protocol** (`@agentclientprotocol/sdk`).  The ACP layer (`packages/opencode/src/acp/`) lets a host application:

- Initialise and authenticate sessions
- Receive structured tool-call events (bash commands, file edits, etc.)
- Approve or deny permission requests
- Switch models mid-session
- Receive plan/todo list updates

ACP is the protocol used by the official VS Code extension and desktop apps.

---

### 3.4 Passing custom config at startup

Any configuration accepted by `opencode.json` can be passed to a programmatically started server:

```ts
const server = await createOpencodeServer({
  config: {
    model: "anthropic/claude-sonnet-4",
    compaction: { reserved: 15000 },
    provider: {
      openai: { apiKey: process.env.OPENAI_KEY }
    }
  }
})
```

The config is serialised to JSON and passed via the `OPENCODE_CONFIG_CONTENT` environment variable.

---

## Summary

```
Your custom app
      │
      │  HTTP REST + SSE          or          @opencode-ai/sdk
      ▼                                              │
┌──────────────────────────────────────────────────────┐
│               OpenCode HTTP Server (Hono)            │
│  /session  /event  /provider  /config  /permission   │
└──────────────────────────┬───────────────────────────┘
                           │
              ┌────────────▼────────────┐
              │     Session Layer       │
              │  session/prompt.ts      │
              │  session/processor.ts   │
              │  session/llm.ts         │
              └────────────┬────────────┘
                           │
              ┌────────────▼────────────┐
              │   Compaction Layer      │
              │  compaction.ts          │
              │  (prune + summarise)    │
              └────────────┬────────────┘
                           │
       ┌───────────────────▼──────────────────────┐
       │              Storage Layer               │
       │  SQLite (Drizzle ORM)                    │
       │  session / message / part / todo tables  │
       └──────────────────────────────────────────┘
                           │
              ┌────────────▼────────────┐
              │     Event Bus           │
              │  bus/index.ts           │
              │  PubSub  ──►  SSE       │
              └─────────────────────────┘
```
