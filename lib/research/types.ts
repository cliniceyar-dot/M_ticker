/** Bullish vs. Bearish research — shared data model (maps to the logical research_* entities). */

export type Direction = "BULLISH" | "BEARISH" | "MIXED" | "NEUTRAL";
export type Level = "high" | "medium" | "low";
export type Horizon = "short_term" | "medium_term" | "long_term";
export type Verification = "confirmed_fact" | "management_statement" | "analyst_interpretation" | "opinion" | "speculation";
export type SourceKind = "sec_filing" | "company_release" | "news" | "video" | "social" | "other";
export type Channel = "sec" | "strategy" | "news" | "youtube" | "x" | "instagram";

/** research_sources */
export interface ResearchSource {
  id: string;
  url: string;
  title: string;
  provider: string; // e.g. "SEC EDGAR", "bloomberg.com", "youtube.com"
  kind: SourceKind;
  channel: Channel;
  published_at: string | null; // when it became public (ISO), null if unknown
  retrieved_at: string; // when we fetched it
  form?: string; // SEC form type
  period?: string; // reporting period, e.g. "FY2025" / "Q2 FY2026"
}

/** research_evidence */
export interface ResearchEvidence {
  id: string;
  source_ids: string[];
  claim: string;
  direction: Direction;
  materiality: Level;
  verification: Verification;
  horizon: Horizon;
  /** Duplicate-reporting cluster: items about the same underlying event share a key. */
  event_key: string;
  published_at: string | null;
  metrics?: Record<string, number | string | null>;
  channel: Channel;
}

/** research_arguments */
export interface ResearchArgument {
  id: string;
  side: "bullish" | "bearish";
  rank: number;
  title: string;
  explanation: string;
  evidence_summary: string;
  evidence_ids: string[];
  source_ids: string[];
  materiality: Level;
  evidence_strength: Level;
  time_horizon: Horizon;
  latest_date: string | null;
  independent_events: number;
  verification_mix: Verification[];
  counter_evidence_ids: string[];
}

/** research_conflicts */
export interface ResearchConflict {
  id: string;
  description: string;
  evidence_ids: string[];
  resolution: "unresolved" | "official_source_prevails" | "confidence_reduced";
}

/** research_coverage */
export interface ChannelCoverage {
  channel: Channel;
  requested: boolean;
  status: "ok" | "partial" | "unavailable" | "skipped" | "error";
  window: { from: string; to: string };
  items: number;
  note?: string;
}

export interface AnalysisOptions {
  company_history_months: number;
  recent_media_months: number;
  include_sec: boolean;
  include_strategy: boolean;
  include_news: boolean;
  include_youtube: boolean;
  include_x: boolean;
  include_instagram: boolean;
}

export const DEFAULT_OPTIONS: AnalysisOptions = {
  company_history_months: 36,
  recent_media_months: 3,
  include_sec: true,
  include_strategy: true,
  include_news: true,
  include_youtube: true,
  include_x: true,
  include_instagram: true,
};

/** research_analyses */
export interface BullBearAnalysis {
  analysis_id: string;
  ticker: string;
  company_name: string | null;
  cik: string | null;
  as_of: string;
  created_at: string;
  completed_at: string | null;
  status: "queued" | "running" | "completed" | "failed";
  error?: string;
  options: AnalysisOptions;
  bullish_arguments: ResearchArgument[];
  bearish_arguments: ResearchArgument[];
  insufficient: { bullish: boolean; bearish: boolean };
  evidence: ResearchEvidence[];
  sources: ResearchSource[];
  conflicts: ResearchConflict[];
  coverage: ChannelCoverage[];
  data_quality: {
    research_complete: boolean;
    freshness: "fresh" | "stale" | "unknown";
    last_successful_update: string | null;
    missing_sources: string[];
    warnings: string[];
  };
  audit: {
    engine: "claude" | "rules";
    model: string | null;
    prompt_version: string;
    pipeline_version: string;
    run_ms: number | null;
  };
}
