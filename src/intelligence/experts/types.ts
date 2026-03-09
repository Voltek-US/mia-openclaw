import type { SyncDataRow } from "../bi-store.js";

export type SourceName = "chat" | "crm" | "projects" | "social" | "financial";

export interface Expert {
  name: string;
  taggedSources: SourceName[];
  rolePrompt: string;
}

/** Signals grouped by source name. */
export type SignalSet = Partial<Record<SourceName, SyncDataRow[]>>;

export interface ExpertAnalysis {
  expert: string;
  text: string;
  signalCount: number;
  model: string;
}

export interface Recommendation {
  rank: number;
  title: string;
  rationale: string;
  priority: "high" | "medium" | "low";
  contributingDomains: string[];
}

export interface CouncilRunResult {
  runId: string;
  expertAnalyses: ExpertAnalysis[];
  recommendations: Recommendation[];
  runDurationMs: number;
  skippedExperts: string[];
}
