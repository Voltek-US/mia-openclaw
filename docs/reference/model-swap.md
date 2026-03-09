---
title: Model Swap Procedure
summary: How to switch the active LLM provider and verify the swap succeeded.
---

# Model Swap Procedure

This document covers how to safely swap the active model, verify the change took effect, and
confirm the correct prompt stack is in use.

## 1. Update the Model Config

Set the new model in your agent config. The config key is `model` (or `defaultModel` in agent
defaults). Example:

```sh
openclaw config set model "gpt-4o"
# or
openclaw config set model "claude-sonnet-4-6"
```

Model aliases are resolved automatically by `shared/model-utils.js`. Common aliases:

| Alias      | Resolves to         |
| ---------- | ------------------- |
| `opus-4`   | `claude-opus-4-6`   |
| `sonnet-4` | `claude-sonnet-4-6` |
| `haiku-4`  | `claude-haiku-4-5`  |

## 2. Restart the Gateway

The gateway must restart to pick up the new model config. On macOS, use the OpenClaw menu bar
app. Alternatively:

```sh
pkill -9 -f openclaw-gateway || true
nohup openclaw gateway run --bind loopback --port 18789 --force \
  > /tmp/openclaw-gateway.log 2>&1 &
```

Verify the gateway is running:

```sh
openclaw channels status --probe
ss -ltnp | rg 18789
tail -n 30 /tmp/openclaw-gateway.log
```

## 3. Canary Verification

Send a structured test prompt and inspect the `provider` field in the response metadata. The
`shared/test-router.mjs` script does this automatically:

```sh
bun shared/test-router.mjs
```

It will print the resolved model, provider, token counts, and a short response. Confirm:

- `provider` matches the expected value (`"anthropic"` or `"openai"`)
- `model` matches the fully-qualified model ID (not an alias)
- Response text is coherent

**If the metadata shows the wrong provider:** authentication failed and the router fell back to
its default. Check credentials:

- For Anthropic: verify `ANTHROPIC_API_KEY` or the OAuth token configured in
  `shared/anthropic-agent-sdk.js`
- For OpenAI: verify `OPENAI_API_KEY`

Then re-run the canary test.

## 4. Verify the Active Prompt Stack

After confirming the correct provider is responding, verify the prompt stack matches:

```js
// Quick check in Node/Bun REPL:
import { getPromptStack } from "./shared/llm-router.js";
console.log(getPromptStack("gpt-4o")); // → 'prompts/openai'
console.log(getPromptStack("claude-sonnet-4-6")); // → 'prompts/claude'
```

Or from the command line:

```sh
bun -e "
import { getPromptStack } from './shared/llm-router.js';
const model = process.env.OPENCLAW_MODEL ?? 'claude-sonnet-4-6';
console.log('Active prompt stack:', getPromptStack(model));
"
```

The two prompt stacks live at:

- `prompts/claude/` — Claude-optimized (natural language, explains "why")
- `prompts/openai/` — GPT-optimized (XML structure, ALL-CAPS emphasis)

## 5. Run Sync Check

After any model swap (or after editing either prompt stack), run the sync check to confirm the
two stacks have no fact drift:

```sh
bun scripts/prompt-sync-check.ts
```

Exit code 0 means the stacks are in sync. Exit code 1 means there are discrepancies — the output
will show exactly what's missing or mismatched.

## Troubleshooting

| Symptom                                           | Likely cause                                | Fix                                         |
| ------------------------------------------------- | ------------------------------------------- | ------------------------------------------- |
| Wrong `provider` in canary                        | Auth failed, fallback active                | Check API key / OAuth token                 |
| `Unknown provider` error in router                | Model name not recognized                   | Use a known alias or full model ID          |
| Sync check fails immediately after stack creation | Fact present in one stack but not the other | Update the missing file to include the fact |
| Gateway not starting                              | Port 18789 still in use                     | `pkill -9 -f openclaw-gateway` then retry   |
