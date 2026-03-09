---
title: "Tiered Testing"
summary: "Three automated test cron scripts: nightly unit tests (free), weekly live LLM tests (low cost), and weekly full e2e tests (moderate cost) — each reporting failures via messaging."
---

# Tiered Testing

Three cron scripts run the test suite on a tiered schedule based on cost and scope. All report failures via `openclaw message send` to `TEST_CHANNEL`. Silent success is the correct behavior.

## Environment Variables

| Variable             | Required | Description                                 |
| -------------------- | -------- | ------------------------------------------- |
| `TEST_CHANNEL`       | yes      | Messaging target for failure alerts         |
| `CLAWDBOT_LIVE_TEST` | Tier 2   | Set to `1` by `test-tier2.ts` automatically |
| `LIVE`               | Tier 3   | Set to `1` by `test-tier3.ts` automatically |
| API keys             | Tier 2+3 | Provider API keys must be in environment    |

---

## Tier 1 — Nightly, Free

**File:** `scripts/test-tier1.ts`
**Schedule:** Nightly at 02:00
**Command:** `OPENCLAW_TEST_PROFILE=low pnpm test`
**Log:** `/tmp/test-tier1.log`
**LLM calls:** None
**Cost:** Free

Runs the full unit and integration test suite with the low-memory profile. No live API calls. Suitable for running every night without incurring any cost.

On failure, sends:

```
Tier 1 tests FAILED (nightly):
<first 800 chars of test output>
```

### Usage

```bash
bun scripts/test-tier1.ts [--verbose]
```

---

## Tier 2 — Weekly (Sunday), Low Cost

**File:** `scripts/test-tier2.ts`
**Schedule:** Sunday at 03:00
**Command:** `CLAWDBOT_LIVE_TEST=1 pnpm test:live`
**Log:** `/tmp/test-tier2.log`
**LLM calls:** Yes — uses real model API
**Cost:** Low (short prompts, small models)

Runs live tests that make real LLM API calls. Requires provider API keys in environment. The script sets `CLAWDBOT_LIVE_TEST=1` automatically.

On failure, sends the first 10 failing test names extracted from output:

```
Tier 2 tests FAILED (weekly live LLM):
FAIL src/agents/tools/memory-tool.citations.test.ts
× citation mode auto suppresses in group context
```

### Usage

```bash
bun scripts/test-tier2.ts [--verbose]
```

---

## Tier 3 — Weekly (Saturday), Moderate Cost

**File:** `scripts/test-tier3.ts`
**Schedule:** Saturday at 04:00
**Command:** `LIVE=1 pnpm test:live`
**Log:** `/tmp/test-tier3.log`
**LLM calls:** Yes — full suite including provider live tests
**Cost:** Moderate (includes messaging platform round-trips)

Full end-to-end test suite including real messaging platform round-trips. Requires all provider credentials. The script sets `LIVE=1` automatically.

On failure, sends failing e2e test names:

```
Tier 3 tests FAILED (weekly full e2e):
FAIL src/channels/telegram.e2e.test.ts
× message delivery round-trip
```

### Usage

```bash
bun scripts/test-tier3.ts [--verbose]
```

---

## Schedule Summary

| Tier | File            | Cron        | Scope                            | Cost     |
| ---- | --------------- | ----------- | -------------------------------- | -------- |
| 1    | `test-tier1.ts` | `0 2 * * *` | Unit + integration, no LLM       | Free     |
| 2    | `test-tier2.ts` | `0 3 * * 0` | Live LLM calls                   | Low      |
| 3    | `test-tier3.ts` | `0 4 * * 6` | Full e2e + messaging round-trips | Moderate |

Tier 1 runs nightly so regressions are caught within 24 hours. Tiers 2 and 3 run on opposite days (Sunday / Saturday) to spread cost across the week.

---

## Manual Runs

Trigger any tier at any time:

```bash
# Tier 1 — safe to run anytime, no cost
bun scripts/test-tier1.ts --verbose

# Tier 2 — requires API keys
CLAWDBOT_LIVE_TEST=1 pnpm test:live

# Tier 3 — requires all credentials
LIVE=1 pnpm test:live
```

See [testing docs](/testing) for the full test command reference.
