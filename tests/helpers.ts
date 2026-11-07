import type { Classification, Evidence, InsiderAnalysis, InsiderTransaction, MarketContext } from "@/lib/types";

export function market(over: Partial<MarketContext> = {}): MarketContext {
  return {
    available: true,
    provider: "test",
    last_price: 34.18,
    prev_close: 30.68,
    stock_move_pct: 11.4,
    stock_gap_pct: 8,
    sector_etf: "XLK",
    sector_move_pct: 1.5,
    spy_move_pct: 0.4,
    qqq_move_pct: 0.6,
    relative_return_to_sector: 9.9,
    relative_volume: 4.7,
    volume_vs_20d: 4.7,
    atr_pct: 3,
    gap_vs_atr: 2.5,
    d0_high: 35,
    bar_date: "2026-11-06",
    history: [],
    ...over,
  };
}

export function noInsiders(): InsiderAnalysis {
  return { signal: "NEUTRAL", score: 0, score_breakdown: [], transactions: [], form4_count: 0, available: true };
}

export function evidence(over: Partial<Evidence> = {}): Evidence {
  return {
    id: "sec-1",
    source_type: "SEC_FILING",
    source_name: "SEC EDGAR 8-K",
    source_url: "https://www.sec.gov/x",
    headline: "8-K: Item 2.02 Results of Operations and Financial Condition",
    first_public_timestamp: "2026-11-06T13:03:00.000Z",
    form: "8-K",
    items: ["2.02", "9.01"],
    excerpt: "",
    ...over,
  };
}

export function tx(over: Partial<InsiderTransaction> = {}): InsiderTransaction {
  return {
    filed_at: "2026-10-22T20:00:00.000Z",
    trade_date: "2026-10-20",
    owner: "Doe Jane",
    title: "Chief Executive Officer",
    is_director: false,
    is_officer: true,
    is_ten_pct: false,
    code: "P",
    acquired_disposed: "A",
    shares: 10000,
    price: 31,
    value: 310000,
    owned_after: 60000,
    pct_change_ownership: 20,
    plan_10b5_1: false,
    source_url: "https://www.sec.gov/f4",
    ...over,
  };
}

export function classification(over: Partial<Classification> = {}): Classification {
  return {
    engine: "rules",
    category: "EARNINGS_GUIDANCE_RAISE",
    headline: "Q3 beat + raised FY guidance",
    event_time: "2026-11-06T13:03:00.000Z",
    new_or_materialization: "NEW",
    novelty_score: 85,
    materiality_score: 88,
    surprise: 80,
    credibility: 95,
    certainty: 95,
    catalyst_strength: 22,
    secondary_catalysts: [],
    evidence_ids: ["sec-1", "sec-2"],
    conflicts: [],
    high_authority_conflict: false,
    causal_attribution: "HIGH",
    possible_drivers: [],
    reasoning_summary: "",
    main_risk: "",
    ...over,
  };
}
