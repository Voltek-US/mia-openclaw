# Operational Facts

These are the stable operational facts for this workspace. When you need a path, command, or ID,
look here rather than guessing. If something here is wrong, update it — this file is your source
of truth.

## Gateway

The gateway runs as the menubar app on macOS. There is no separate LaunchAgent. Restart it via
the OpenClaw Mac app or by running:

```sh
pkill -9 -f openclaw-gateway || true
nohup openclaw gateway run --bind loopback --port 18789 --force \
  > /tmp/openclaw-gateway.log 2>&1 &
```

After restarting, verify with:

```sh
openclaw channels status --probe
ss -ltnp | rg 18789
tail -n 120 /tmp/openclaw-gateway.log
```

## Log Paths

| Log               | Path                                                 |
| ----------------- | ---------------------------------------------------- |
| Gateway log       | `/tmp/openclaw-gateway.log`                          |
| LLM call database | `~/.openclaw/llm-calls.db` (or `$LLM_LOG_DB` if set) |
| Agent sessions    | `~/.openclaw/agents/<agentId>/sessions/*.jsonl`      |
| macOS unified log | query via `./scripts/clawlog.sh`                     |

## Monitoring Channel

Set `PROMPT_SYNC_CHANNEL` in your environment to route sync-check reports to a channel. If unset,
the sync check writes to stdout only.

Example: `export PROMPT_SYNC_CHANNEL="your-channel-id-here"`

## Prompt Stacks

Both stacks live under `prompts/` in the repo root:

- `prompts/claude/` — Claude-optimized (this stack): natural language, explains "why"
- `prompts/openai/` — GPT-optimized: XML structure, ALL-CAPS emphasis

The active stack for a given model is resolved by `getPromptStack(model)` in
`shared/llm-router.js`. Default is the Claude stack.

## Cron Naming

Cron jobs follow this naming convention: `<scope>-<action>` in kebab-case, e.g.,
`prompt-sync-check`, `log-rotate`, `heartbeat-check`. Use the `bun` runtime for TypeScript
scripts; use `openclaw` for gateway commands.

Nightly jobs run at 03:00 local time to avoid interfering with heartbeat cycles.

## Model Swap Verification

After swapping models, send a canary message and check that the `provider` field in the response
metadata matches the expected provider. Use `shared/test-router.mjs` for a quick smoke test:

```sh
bun shared/test-router.mjs
```

See `docs/reference/model-swap.md` for the full procedure.

## Key File Paths (Repo-Relative)

| Purpose                  | Path                            |
| ------------------------ | ------------------------------- |
| LLM router               | `shared/llm-router.js`          |
| Model utilities          | `shared/model-utils.js`         |
| Anthropic SDK wrapper    | `shared/anthropic-agent-sdk.js` |
| Interaction store        | `shared/interaction-store.js`   |
| System prompt builder    | `src/agents/system-prompt.ts`   |
| Prompt sync check        | `scripts/prompt-sync-check.ts`  |
| CLI progress utilities   | `src/cli/progress.ts`           |
| Terminal table utilities | `src/terminal/table.ts`         |
| Color palette            | `src/terminal/palette.ts`       |
