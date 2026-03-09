---
summary: "Unified LLM routing layer for scripts — OAuth auth, SQLite logging, cost tracking"
read_when:
  - You want to call Claude from a Node.js script without managing auth yourself
  - You need LLM call logging and cost estimation in your scripts
  - You want a single import that routes to the right provider automatically
title: "LLM Router (shared/)"
---

# LLM Router (`shared/`)

The `shared/` directory contains a lightweight Node.js routing layer that lets any
script in the repo call Claude (and other LLM providers) with a single import.
It handles OAuth authentication via `claude setup-token`, logs every call to
SQLite, and estimates cost automatically.

## What's in `shared/`

| File                            | Purpose                                                       |
| ------------------------------- | ------------------------------------------------------------- |
| `shared/model-utils.js`         | Friendly aliases → official model IDs, provider detection     |
| `shared/interaction-store.js`   | SQLite call logger with redaction and pricing                 |
| `shared/anthropic-agent-sdk.js` | OAuth wrapper around `@anthropic-ai/claude-agent-sdk`         |
| `shared/llm-router.js`          | Single `runLlm()` entry point — pick provider from model name |

All modules are ESM. The `shared/package.json` (`"type": "module"`) makes this
transparent: import with `import { runLlm } from './shared/llm-router.js'`.

---

## Setup

### 1. Install the Agent SDK

```bash
pnpm add -w @anthropic-ai/claude-agent-sdk
```

### 2. Get a setup-token

Run on any machine where Claude Code CLI is installed:

```bash
claude setup-token
```

This prints a token starting with `sk-ant-oat01-`. Copy it.

### 3. Add it to `.env`

```bash
# .env (at repo root)
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-<your-token-here>
```

Do **not** set `ANTHROPIC_API_KEY` at the same time — it conflicts with OAuth mode and `anthropic-agent-sdk.js` will throw on import.

---

## Basic usage

```js
// my-script.mjs
import { runLlm } from "./shared/llm-router.js";

const { text, provider, durationMs } = await runLlm(
  "Summarize the key risks in this contract: ...",
  {
    model: "claude-sonnet-4", // alias → claude-sonnet-4-6
    caller: "my-script", // label shown in the SQLite log
  },
);

console.log(text);
// provider   → 'anthropic'
// durationMs → wall-clock ms for the full round-trip
```

Run your script with `CLAUDECODE` unset (required when running inside a Claude
Code session, because the Agent SDK spawns `claude` as a subprocess):

```bash
env -u CLAUDECODE node my-script.mjs
```

If you run outside a Claude Code session (e.g. cron, CI), no special flags are needed.

---

## `runLlm(prompt, options)` — reference

```js
import { runLlm } from "./shared/llm-router.js";

const result = await runLlm(prompt, {
  model: "claude-sonnet-4-6", // model name or alias (default: claude-sonnet-4-6)
  timeoutMs: 60_000, // abort after N ms (default: 60 000)
  caller: "my-script", // tag written to the SQLite log
  skipLog: false, // true → skip interaction-store write
});
// result: { text, provider, durationMs }
```

**Routing logic:** `detectModelProvider(model)` is called on the (possibly
aliased) model name. Anthropic models go to `runAnthropicAgentPrompt()`;
all others throw a clear "not yet implemented" error so you know to add a handler.

---

## Model aliases

The router resolves friendly aliases before routing. All aliases expand to the
current latest release of that family:

| Alias                | Resolves to                  |
| -------------------- | ---------------------------- |
| `opus-4`             | `claude-opus-4-6`            |
| `opus-4.5`           | `claude-opus-4-5`            |
| `sonnet-4`           | `claude-sonnet-4-6`          |
| `sonnet-4.5`         | `claude-sonnet-4-5`          |
| `haiku-4`            | `claude-haiku-4-5`           |
| `claude-opus-4`      | `claude-opus-4-6`            |
| `claude-sonnet-4`    | `claude-sonnet-4-6`          |
| `claude-haiku-4`     | `claude-haiku-4-5`           |
| `anthropic/claude-*` | strips prefix, then resolves |

Full official IDs (`claude-opus-4-6`, etc.) pass through unchanged.

---

## Using model utilities directly

```js
import {
  isAnthropicModel,
  normalizeAnthropicModel,
  detectModelProvider,
  MODEL_ALIASES,
} from "./shared/model-utils.js";

isAnthropicModel("claude-opus-4-6"); // true
isAnthropicModel("gpt-4o"); // false

normalizeAnthropicModel("opus-4"); // 'claude-opus-4-6'
normalizeAnthropicModel("anthropic/claude-sonnet-4-6"); // 'claude-sonnet-4-6'

detectModelProvider("claude-haiku-4-5"); // 'anthropic'
detectModelProvider("gpt-4o"); // 'openai'
detectModelProvider("llama3-local"); // null
```

---

## Call logging (SQLite)

Every `runLlm()` call is logged to `~/.openclaw/llm-calls.db` by default.
Override the path with the `LLM_LOG_DB` env var.

### Schema

```sql
CREATE TABLE llm_calls (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp     TEXT,     -- ISO 8601
  provider      TEXT,     -- 'anthropic'
  model         TEXT,     -- official model ID
  caller        TEXT,     -- value passed as options.caller
  prompt        TEXT,     -- truncated to 10 000 chars, redacted
  response      TEXT,     -- truncated to 10 000 chars, redacted
  input_tokens  INTEGER,
  output_tokens INTEGER,
  cost_estimate REAL,     -- USD; exact from provider when available
  duration_ms   INTEGER,
  ok            INTEGER,  -- 1 = success, 0 = error
  error         TEXT
);
```

### Query recent calls

```bash
node -e "
  import { DatabaseSync } from 'node:sqlite';
  import { homedir } from 'node:os';
  import { join } from 'node:path';
  const db = new DatabaseSync(join(homedir(), '.openclaw', 'llm-calls.db'));
  console.table(
    db.prepare('SELECT id, timestamp, model, caller, input_tokens, output_tokens, cost_estimate, duration_ms, ok FROM llm_calls ORDER BY id DESC LIMIT 10').all()
  );
" 2>/dev/null
```

### Redaction

Before storage, the logger redacts anything that looks like an API key or
bearer token:

- `sk-ant-oat01-...` (setup-tokens)
- `Bearer <token>` patterns
- `api_key=...` / `oauth_token=...` patterns
- `CLAUDE_CODE_OAUTH_TOKEN=...` literals

Prompt and response text is also truncated to 10 000 characters.

### Pricing table

Cost is calculated from actual token counts returned by the provider.
If the provider returns `total_cost_usd`, that is used directly.

| Model             | Input ($/1M) | Output ($/1M)     |
| ----------------- | ------------ | ----------------- |
| claude-opus-4-6   | $5.00        | $25.00            |
| claude-sonnet-4-6 | $3.00        | $15.00            |
| claude-haiku-4-5  | $1.00        | $5.00             |
| (unknown)         | $5.00        | $25.00 (fallback) |

### Using the store directly

```js
import {
  logLlmCall,
  estimateCost,
  estimateTokensFromChars,
  redact,
} from "./shared/interaction-store.js";

// Log manually (fire-and-forget — never throws)
logLlmCall({
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  caller: "my-script",
  prompt: userPrompt,
  response: assistantResponse,
  inputTokens: 500,
  outputTokens: 120,
  durationMs: 1800,
  ok: true,
});

// Cost helpers
estimateCost("claude-sonnet-4-6", 1_000_000, 500_000); // → 10.5 (USD)
estimateTokensFromChars(400); // → 100
redact("token: sk-ant-oat01-abc123..."); // → 'token: [REDACTED]'
```

---

## Anthropic SDK wrapper — advanced

`runAnthropicAgentPrompt()` is the Anthropic-specific layer below `runLlm()`.
Use it directly when you need more control:

```js
import { runAnthropicAgentPrompt } from "./shared/anthropic-agent-sdk.js";

const { text } = await runAnthropicAgentPrompt({
  prompt: "Classify this text as positive, neutral, or negative: ...",
  model: "claude-haiku-4-5", // official model ID only (no aliases)
  timeoutMs: 30_000,
  caller: "sentiment-classifier",
  maxTurns: 1, // always 1 for single-shot prompts
  skipLog: false,
});
```

### Smoke test

The first real call per process sends a lightweight AUTH_OK probe to verify
credentials before committing to the real prompt. If it fails, you get a clear
error instead of a confusing mid-request failure.

Skip the smoke test (e.g. in CI where you've already verified credentials):

```bash
ANTHROPIC_SKIP_SMOKE_TEST=1 node my-script.mjs
```

### OAuth token resolution order

On module import, `anthropic-agent-sdk.js` resolves the token in this order:

1. `CLAUDE_CODE_OAUTH_TOKEN` environment variable
2. `CLAUDE_CODE_OAUTH_TOKEN=...` line in `.env` at `process.cwd()`
3. Throws with a clear error if neither found

If `ANTHROPIC_API_KEY` is also set, the module throws immediately — it
conflicts with OAuth mode.

---

## Adding an OpenAI handler

The router stubs out OpenAI with a "not yet implemented" error. To add it:

```js
// shared/llm-router.js — add inside the openai branch:
if (provider === "openai") {
  // import your OpenAI wrapper here
  const { runOpenAiPrompt } = await import("./openai-sdk.js");
  const result = await runOpenAiPrompt({ model, prompt, timeoutMs, caller, skipLog });
  return { ...result, durationMs: Date.now() - start };
}
```

---

## Environment variables reference

| Variable                    | Default                    | Description                                          |
| --------------------------- | -------------------------- | ---------------------------------------------------- |
| `CLAUDE_CODE_OAUTH_TOKEN`   | —                          | Setup-token from `claude setup-token` **(required)** |
| `ANTHROPIC_API_KEY`         | —                          | Must **not** be set in OAuth mode                    |
| `ANTHROPIC_SKIP_SMOKE_TEST` | unset                      | Set to `1` to skip the AUTH_OK probe                 |
| `LLM_LOG_DB`                | `~/.openclaw/llm-calls.db` | Override SQLite log path                             |

---

## Onboarding integration

When you run `openclaw onboard` and choose the **Anthropic token** option,
the wizard now tells you to run `claude setup-token` and prompts you to paste
the output. In ref mode it looks for the token in `CLAUDE_CODE_OAUTH_TOKEN`
— the same variable `shared/anthropic-agent-sdk.js` uses — so scripts and the
gateway share a single credential.

```
◆ Anthropic setup-token
│ Run `claude setup-token` in your terminal.
│ Then paste the generated token below (or set CLAUDE_CODE_OAUTH_TOKEN in your environment).
```

---

## Running the test suite

```bash
env -u CLAUDECODE PATH="$HOME/.local/bin:$PATH" node shared/test-router.mjs
```

Expected output:

```
=== model-utils ===
  normalizeAnthropicModel('opus-4') → 'claude-opus-4-6' ✓
  normalizeAnthropicModel('sonnet-4') → 'claude-sonnet-4-6' ✓
  normalizeAnthropicModel('haiku-4') → 'claude-haiku-4-5' ✓
  normalizeAnthropicModel('claude-opus-4') → 'claude-opus-4-6' ✓
  model-utils assertions passed ✓

=== interaction-store ===
  estimateCost sonnet 1M/0.5M → $10.5000 (expected $10.50)
  interaction-store assertions passed ✓

=== runLlm (live call) ===
  provider : anthropic
  durationMs: ~1800
  text     : ROUTER TEST PASSED
  runLlm live call ✓

All checks passed.
```

Use `ANTHROPIC_SKIP_SMOKE_TEST=1` to skip the AUTH_OK probe during the test.
