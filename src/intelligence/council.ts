import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  insertExpertAnalysis,
  insertRecommendation,
  querySyncData,
  type SyncDataRow,
} from "./bi-store.js";
import { EXPERTS } from "./experts/personas.js";
import type {
  CouncilRunResult,
  Expert,
  ExpertAnalysis,
  Recommendation,
  SignalSet,
  SourceName,
} from "./experts/types.js";

// ============================================================================
// Options
// ============================================================================

export interface CouncilOptions {
  dryRun?: boolean;
  verbose?: boolean;
  /** How many days of synced data to include. Default: 3 */
  lookbackDays?: number;
}

// ============================================================================
// Main orchestration
// ============================================================================

export async function runCouncil(
  db: DatabaseSync,
  opts: CouncilOptions = {},
): Promise<CouncilRunResult> {
  const { verbose = false, dryRun = false, lookbackDays = 3 } = opts;
  const runId = crypto.randomUUID();
  const start = Date.now();

  const log = (...args: unknown[]) => {
    if (verbose) {
      console.log("[council]", ...args);
    }
  };

  log(`Starting council run ${runId} (lookback: ${lookbackDays}d, dryRun: ${dryRun})`);

  // 1. Load signals from the last lookbackDays days, grouped by source.
  const since = Date.now() - lookbackDays * 86_400_000;
  const allRows = querySyncData(db, { since, limit: 2000 });
  const signals = groupBySource(allRows);

  const totalSignals = allRows.length;
  const sourceNames = Object.keys(signals) as SourceName[];
  log(`Loaded ${totalSignals} signals from sources: ${sourceNames.join(", ") || "none"}`);

  // 2. Build cross-domain brief for context.
  const brief = buildCrossDomainBrief(signals, lookbackDays);

  // 3. Fan out to all experts in parallel; use allSettled so one failure doesn't abort all.
  if (process.env.COUNCIL_SKIP_LLM === "1") {
    log("COUNCIL_SKIP_LLM=1 — returning stub result");
    return buildStubResult(runId, start);
  }

  // Dynamically import the LLM router (JS module from shared/).
  const { runLlm } = (await import("../../shared/llm-router.js")) as {
    runLlm: (prompt: string, opts?: Record<string, unknown>) => Promise<{ text: string }>;
  };

  const expertResults = await Promise.allSettled(
    EXPERTS.map((expert) => runExpert(expert, signals, brief, runLlm, verbose)),
  );

  const expertAnalyses: ExpertAnalysis[] = [];
  const skippedExperts: string[] = [];

  for (let i = 0; i < expertResults.length; i++) {
    const result = expertResults[i];
    const expert = EXPERTS[i];
    if (result.status === "fulfilled") {
      expertAnalyses.push(result.value);
    } else {
      console.warn(`[council] Expert ${expert.name} failed:`, result.reason);
      skippedExperts.push(expert.name);
    }
  }

  log(`${expertAnalyses.length} experts completed, ${skippedExperts.length} skipped`);

  // 4. Synthesis pass.
  const synthPrompt = buildSynthesisPrompt(expertAnalyses, signals, lookbackDays);
  log("Running synthesis...");

  let recommendations: Recommendation[] = [];
  try {
    const { text } = await runLlm(synthPrompt, {
      model: "claude-sonnet-4-6",
      caller: "council-synthesizer",
      timeoutMs: 120_000,
    });
    if (verbose) {
      console.log("[council] synthesis raw output:", text);
    }
    recommendations = parseSynthesisOutput(text);
    log(`Parsed ${recommendations.length} recommendations`);
  } catch (err) {
    console.warn("[council] Synthesis failed:", err);
  }

  // 5. Persist to DB (skip if dry run).
  if (!dryRun) {
    const now = Date.now();
    for (const analysis of expertAnalyses) {
      insertExpertAnalysis(db, {
        run_id: runId,
        expert_name: analysis.expert,
        analysis_text: analysis.text,
        signal_count: analysis.signalCount,
        model: analysis.model,
        created_at: now,
      });
    }
    for (const rec of recommendations) {
      insertRecommendation(db, {
        run_id: runId,
        rank: rec.rank,
        title: rec.title,
        rationale: rec.rationale,
        priority: rec.priority,
        contributing_domains: JSON.stringify(rec.contributingDomains),
        created_at: now,
      });
    }
    log(
      `Persisted ${expertAnalyses.length} analyses and ${recommendations.length} recommendations`,
    );
  }

  return {
    runId,
    expertAnalyses,
    recommendations,
    runDurationMs: Date.now() - start,
    skippedExperts,
  };
}

// ============================================================================
// Expert execution
// ============================================================================

async function runExpert(
  expert: Expert,
  signals: SignalSet,
  crossDomainBrief: string,
  runLlm: (prompt: string, opts?: Record<string, unknown>) => Promise<{ text: string }>,
  verbose: boolean,
): Promise<ExpertAnalysis> {
  // Filter signals to only this expert's tagged sources.
  const expertSignals: SyncDataRow[] = [];
  for (const src of expert.taggedSources) {
    const rows = signals[src] ?? [];
    expertSignals.push(...rows);
  }

  const prompt = buildExpertPrompt(expert, expertSignals, crossDomainBrief);

  if (verbose) {
    console.log(`[council] Running ${expert.name} with ${expertSignals.length} signals...`);
  }

  const { text } = await runLlm(prompt, {
    model: "claude-opus-4-6",
    caller: `council-expert-${expert.name}`,
    timeoutMs: 90_000,
  });

  return {
    expert: expert.name,
    text: text.trim(),
    signalCount: expertSignals.length,
    model: "claude-opus-4-6",
  };
}

// ============================================================================
// Prompt builders
// ============================================================================

function groupBySource(rows: SyncDataRow[]): SignalSet {
  const result: SignalSet = {};
  for (const row of rows) {
    const src = row.source as SourceName;
    if (!result[src]) {
      result[src] = [];
    }
    result[src].push(row);
  }
  return result;
}

function buildCrossDomainBrief(signals: SignalSet, lookbackDays: number): string {
  const lines: string[] = [
    `Cross-domain brief — last ${lookbackDays} days`,
    `Synced sources: ${Object.keys(signals).join(", ") || "none"}`,
  ];
  for (const [src, rows] of Object.entries(signals)) {
    if (rows && rows.length > 0) {
      lines.push(`  ${src}: ${rows.length} records`);
    }
  }
  return lines.join("\n");
}

function buildExpertPrompt(expert: Expert, signals: SyncDataRow[], brief: string): string {
  const signalBlock =
    signals.length > 0
      ? signals
          .slice(0, 100) // cap to avoid token overflow
          .map(
            (r, i) =>
              `[${i + 1}] source=${r.source} type=${r.data_type}\n${truncate(r.content_json, 400)}`,
          )
          .join("\n\n")
      : "No signals available for this expert's domains.";

  return `${expert.rolePrompt}

== CROSS-DOMAIN BRIEF ==
${brief}

== YOUR DOMAIN SIGNALS ==
Tagged sources: ${expert.taggedSources.join(", ")}

${signalBlock}`;
}

function buildSynthesisPrompt(
  analyses: ExpertAnalysis[],
  signals: SignalSet,
  lookbackDays: number,
): string {
  const brief = buildCrossDomainBrief(signals, lookbackDays);
  const analysisBlock = analyses
    .map((a) => `=== ${a.expert} (${a.signalCount} signals) ===\n${a.text}`)
    .join("\n\n");

  return `You are a business intelligence synthesizer. Below are expert analyses from ${analyses.length} domain experts covering the last ${lookbackDays} days of business signals.

== CROSS-DOMAIN BRIEF ==
${brief}

== EXPERT ANALYSES ==
${analysisBlock || "No expert analyses available."}

== YOUR TASK ==
Synthesize the above into a prioritized recommendation list. Consider which recommendations have cross-domain support (mentioned by multiple experts).

Return EXACTLY this format — one block per recommendation, no other prose before or after:

REC_START
RANK: 1
TITLE: <concise action-oriented title>
PRIORITY: high|medium|low
RATIONALE: <2-3 sentences connecting signals from multiple expert domains>
DOMAINS: <comma-separated expert names that contributed>
REC_END

Rules:
- Maximum 7 recommendations
- Rank by impact × urgency
- PRIORITY must be exactly: high, medium, or low
- DOMAINS must list at least one expert name`;
}

// ============================================================================
// Synthesis output parser
// ============================================================================

function parseSynthesisOutput(text: string): Recommendation[] {
  const recommendations: Recommendation[] = [];
  const blockPattern = /REC_START([\s\S]*?)REC_END/g;
  let match: RegExpExecArray | null;

  while ((match = blockPattern.exec(text)) !== null) {
    const block = match[1];
    try {
      const rank = parseInt(extractField(block, "RANK") ?? "0", 10);
      const title = extractField(block, "TITLE") ?? "";
      const priorityRaw = (extractField(block, "PRIORITY") ?? "medium").toLowerCase().trim();
      const rationale = extractField(block, "RATIONALE") ?? "";
      const domainsRaw = extractField(block, "DOMAINS") ?? "";

      if (!title || !rationale) {
        continue;
      }

      const priority = (["high", "medium", "low"].includes(priorityRaw) ? priorityRaw : "medium") as
        | "high"
        | "medium"
        | "low";

      const contributingDomains = domainsRaw
        .split(",")
        .map((d) => d.trim())
        .filter(Boolean);

      recommendations.push({ rank, title, rationale, priority, contributingDomains });
    } catch {
      // Skip malformed blocks; don't throw.
    }
  }

  return recommendations.toSorted((a, b) => a.rank - b.rank);
}

function extractField(block: string, field: string): string | null {
  const match = new RegExp(`^${field}:\\s*(.+)$`, "m").exec(block);
  return match ? match[1].trim() : null;
}

// ============================================================================
// Stub for COUNCIL_SKIP_LLM=1 (testing without API calls)
// ============================================================================

function buildStubResult(runId: string, start: number): CouncilRunResult {
  return {
    runId,
    expertAnalyses: EXPERTS.map((e) => ({
      expert: e.name,
      text: "FINDING: Stub finding for testing.\nDETAIL: No LLM call was made (COUNCIL_SKIP_LLM=1).",
      signalCount: 0,
      model: "stub",
    })),
    recommendations: [
      {
        rank: 1,
        title: "Stub recommendation (COUNCIL_SKIP_LLM=1)",
        rationale: "This is a stub result for testing the council pipeline without LLM calls.",
        priority: "medium",
        contributingDomains: ["GrowthStrategist", "CFO"],
      },
    ],
    runDurationMs: Date.now() - start,
    skippedExperts: [],
  };
}

// ============================================================================
// Utilities
// ============================================================================

function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : `${s.slice(0, maxLen)}…`;
}
