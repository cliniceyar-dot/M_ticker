export const CATALYST_CATEGORIES = [
  "EARNINGS_POSITIVE_SURPRISE",
  "EARNINGS_GUIDANCE_RAISE",
  "EARNINGS_MIXED",
  "FDA_APPROVAL",
  "FDA_TRIAL_RESULT",
  "M&A_OFFER",
  "M&A_COMPLETION",
  "MAJOR_CONTRACT",
  "PARTNERSHIP",
  "ANALYST_UPGRADE",
  "PRICE_TARGET_RAISE",
  "INDEX_INCLUSION",
  "CAPITAL_RETURN",
  "BUYBACK",
  "DEBT_REFINANCING",
  "LEGAL_REGULATORY_WIN",
  "MANAGEMENT_CHANGE",
  "INSIDER_BUYING",
  "SECTOR_SYMPATHY",
  "MACRO_SYMPATHY",
  "SHORT_SQUEEZE_LIKELY",
  "TECHNICAL_ONLY",
  "RUMOR_UNCONFIRMED",
  "KNOWN_EVENT_MATERIALIZATION",
  "NO_IDENTIFIABLE_NEWS",
  "CONFLICTING_INFORMATION",
] as const;

export type CatalystCategory = (typeof CATALYST_CATEGORIES)[number];

export type SourceType =
  | "SEC_FILING"
  | "FDA"
  | "COMPANY_IR"
  | "WIRE"
  | "AGGREGATOR"
  | "MARKET_DATA"
  | "COMMUNITY";

export type BreakoutPattern = "PEAK" | "CENTER" | "BOTTOM";

export interface BreakoutInput {
  confirmed_by_user: boolean;
  pattern: BreakoutPattern;
  breakout_date: string; // YYYY-MM-DD
  breakout_high: number;
}

export interface Entity {
  ticker: string;
  company_name: string;
  cik: string; // 10-digit padded
  exchange: string | null;
  sic: string | null;
  sector: string | null;
  industry: string | null;
  sector_etf: string;
}

export interface Evidence {
  id: string;
  source_type: SourceType;
  source_name: string;
  source_url: string;
  headline: string;
  first_public_timestamp: string; // ISO
  form?: string;
  items?: string[];
  excerpt?: string;
}

export interface InsiderTransaction {
  filed_at: string;
  trade_date: string;
  owner: string;
  title: string;
  is_director: boolean;
  is_officer: boolean;
  is_ten_pct: boolean;
  code: string;
  acquired_disposed: "A" | "D" | "?";
  shares: number;
  price: number | null;
  value: number | null;
  owned_after: number | null;
  pct_change_ownership: number | null;
  plan_10b5_1: boolean;
  source_url: string;
}

export interface InsiderAnalysis {
  signal: "POSITIVE" | "NEUTRAL" | "NEGATIVE";
  score: number;
  score_breakdown: { label: string; points: number }[];
  transactions: InsiderTransaction[];
  form4_count: number;
  available: boolean;
}

export interface MarketContext {
  available: boolean;
  provider: string;
  last_price: number | null;
  prev_close: number | null;
  stock_move_pct: number | null;
  stock_gap_pct: number | null;
  sector_etf: string;
  sector_move_pct: number | null;
  spy_move_pct: number | null;
  qqq_move_pct: number | null;
  relative_return_to_sector: number | null;
  relative_volume: number | null;
  volume_vs_20d: number | null;
  atr_pct: number | null;
  gap_vs_atr: number | null;
  d0_high: number | null;
  bar_date: string | null;
  history: { date: string; open: number; high: number; low: number; close: number; volume: number }[];
  error?: string;
}

export interface Classification {
  engine: "claude" | "rules";
  model?: string;
  category: CatalystCategory;
  headline: string;
  event_time: string | null;
  new_or_materialization: "NEW" | "MATERIALIZATION" | "MIXED" | "UNKNOWN";
  novelty_score: number; // 0-100
  materiality_score: number; // 0-100
  surprise: number; // 0-100
  credibility: number; // 0-100
  certainty: number; // 0-100
  catalyst_strength: number; // 0-25
  secondary_catalysts: CatalystCategory[];
  evidence_ids: string[];
  conflicts: string[];
  high_authority_conflict: boolean;
  causal_attribution: "HIGH" | "MEDIUM" | "LOW";
  possible_drivers: string[];
  reasoning_summary: string;
  main_risk: string;
  note?: string;
}

export interface ScoreComponent {
  key: string;
  label: string;
  value: number;
  max: number;
  sign: 1 | -1;
  why: string;
}

export interface Report {
  ticker: string;
  as_of: string;
  mode: "LIVE_EVENT_SCAN" | "BREAKOUT_DECISION";
  historical_replay: boolean;
  entity: Entity;
  primary_catalyst: Classification & { source_type: SourceType | null; source_url: string | null };
  freshness: "HIGH" | "MEDIUM" | "LOW" | "STALE";
  hours_since_event: number | null;
  significant_event_now: boolean;
  market_context: MarketContext;
  insider: InsiderAnalysis;
  breakout: BreakoutInput | null;
  raw_score: number;
  score_components: ScoreComponent[];
  probability_no_averaging: number | null; // 0-1, null when suppressed
  probability_basis: string;
  confidence: number; // 0-100
  confidence_breakdown: { label: string; points: number }[];
  status: "OK" | "CONFLICTING_INFORMATION" | "NO_IDENTIFIABLE_NEWS";
  action: string;
  system_state: string | null;
  evidence: Evidence[];
  filings: { form: string; filed_at: string; description: string; url: string }[];
  fda: Evidence[];
  warnings: string[];
  audit: {
    model_version: string;
    skill_version: string;
    scoring_version: string;
    calibration_version: string;
    input_timestamp: string;
    source_timestamps: string[];
    run_ms: number;
  };
}
