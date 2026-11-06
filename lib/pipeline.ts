import { buildFilingEvidence, fetchForm4Transactions, listFilings, resolveEntity } from "./sec";
import { getFdaApprovals } from "./fda";
import { getMarketContext } from "./market";
import { analyzeInsiders } from "./insider";
import { classifyWithClaude, classifyWithRules, CLAUDE_MODEL, SKILL_VERSION } from "./classify";
import { computeConfidence, computeRawScore, seedProbability, SCORING_VERSION, CALIBRATION_VERSION } from "./scoring";
import type { BreakoutInput, Classification, Evidence, InsiderAnalysis, Report } from "./types";

const HOUR = 3600_000;

export interface AnalyzeInput {
  ticker: string;
  asOf?: string | null;
  breakout?: BreakoutInput | null;
  threshold?: number;
}

/**
 * Ticker → Entity Resolution → Event Collection → Evidence Normalization →
 * Catalyst Classification → Market Context → Insider Analysis → Feature Engine →
 * Probability Model → Confidence Layer → Report
 */
export async function analyze(input: AnalyzeInput): Promise<Report> {
  const t0 = Date.now();
  const now = new Date();
  const asOf = input.asOf ? new Date(input.asOf) : now;
  if (Number.isNaN(asOf.getTime())) throw new Error("Invalid as_of timestamp");
  const asOfClamped = asOf.getTime() > now.getTime() ? now : asOf;
  const historical = now.getTime() - asOfClamped.getTime() > 2 * HOUR;
  const breakout = input.breakout?.confirmed_by_user ? input.breakout : null;
  const threshold = input.threshold ?? 0.6;
  const windowHours = breakout ? 72 : 48;
  const warnings: string[] = [];

  // 1. Entity resolution (ticker → CIK → legal entity)
  const { entity, submissions } = await resolveEntity(input.ticker);

  // 2. Event collection (point-in-time: published_at <= as_of)
  const filings = listFilings(submissions, asOfClamped, 120);
  const [filingEvidence, fdaEvidence, market, form4] = await Promise.all([
    buildFilingEvidence(filings, 3).catch((e) => {
      warnings.push(`Filing text fetch failed: ${e.message}`);
      return [] as Evidence[];
    }),
    /biotech|pharma|health/i.test(entity.sector ?? "")
      ? getFdaApprovals(entity.company_name, asOfClamped, 30).catch((e) => {
          warnings.push(`openFDA unavailable: ${e.message}`);
          return [] as Evidence[];
        })
      : Promise.resolve([] as Evidence[]),
    getMarketContext(entity.ticker, entity.sector_etf, asOfClamped),
    fetchForm4Transactions(filings.filter((f) => Date.parse(f.acceptedAt) >= asOfClamped.getTime() - 95 * 86400_000), 15).catch(
      (e) => {
        warnings.push(`Form 4 fetch failed: ${e.message}`);
        return { transactions: [], count: 0 };
      },
    ),
  ]);
  if (!market.available) warnings.push(`Market data unavailable: ${market.error ?? "unknown"}`);
  if (!process.env.SEC_USER_AGENT) warnings.push("SEC_USER_AGENT is not set — SEC asks automated clients to declare a contact.");

  // 3. Evidence normalization
  const evidence: Evidence[] = [...fdaEvidence, ...filingEvidence].sort((a, b) =>
    b.first_public_timestamp.localeCompare(a.first_public_timestamp),
  );

  // 4. Insider analysis
  let insider: InsiderAnalysis = analyzeInsiders(form4.transactions, asOfClamped, form4.count);
  if (form4.count === 0) insider = { ...insider, available: form4.transactions.length > 0 || filings.length > 0 };

  // 5. Catalyst classification (Claude → rules fallback)
  let classification: Classification;
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      classification = await classifyWithClaude(evidence, market, insider, entity.ticker, entity.company_name, asOfClamped, windowHours);
    } catch (e) {
      warnings.push(`Claude classifier failed (${(e as Error).message}); used deterministic rules.`);
      classification = classifyWithRules(evidence, market, insider, asOfClamped, windowHours);
    }
  } else {
    warnings.push("ANTHROPIC_API_KEY not set — deterministic rules classifier in use.");
    classification = classifyWithRules(evidence, market, insider, asOfClamped, windowHours);
  }

  const primaryEv = evidence.find((e) => e.id === classification.evidence_ids[0]) ?? null;
  const hoursSince = classification.event_time ? (asOfClamped.getTime() - Date.parse(classification.event_time)) / HOUR : null;

  // 6. Feature engine + raw score
  const { raw, components } = computeRawScore({
    c: classification,
    sourceType: primaryEv?.source_type ?? null,
    m: market,
    insider,
    hoursSinceEvent: hoursSince,
  });

  // 7. Probability + confidence
  const conflict = classification.high_authority_conflict || classification.category === "CONFLICTING_INFORMATION";
  const { p, basis } = seedProbability(raw, market, breakout);
  const { confidence, breakdown } = computeConfidence({
    entityOk: true,
    m: market,
    filingsOk: filings.length > 0,
    c: classification,
    sourceType: primaryEv?.source_type ?? null,
    insider,
  });

  const noNews = classification.category === "NO_IDENTIFIABLE_NEWS";
  const status: Report["status"] = conflict ? "CONFLICTING_INFORMATION" : noNews ? "NO_IDENTIFIABLE_NEWS" : "OK";
  const probability = conflict ? null : p;

  let freshness: Report["freshness"] = "STALE";
  if (hoursSince !== null) {
    if (classification.new_or_materialization === "MATERIALIZATION") freshness = hoursSince <= 24 ? "MEDIUM" : "LOW";
    else freshness = hoursSince <= 24 ? "HIGH" : hoursSince <= 72 ? "MEDIUM" : "LOW";
  }

  const bigMove = market.stock_move_pct !== null && Math.abs(market.stock_move_pct) >= Math.max(3, 2 * (market.atr_pct ?? 2));
  const significant = (hoursSince !== null && hoursSince <= 48 && classification.materiality_score >= 50) || bigMove;

  let action = "MONITOR";
  let systemState: string | null = null;
  if (conflict) action = "WAIT_FOR_CONFIRMATION";
  else if (breakout) {
    if (probability !== null && probability >= threshold) {
      action = "ENTRY_CANDIDATE";
      systemState = `WATCH IMMEDIATE BREAK OF D0 HIGH (${breakout.breakout_high})`;
    } else {
      action = "WAIT_FOR_AVERAGING_CANDLE";
      systemState = "WAIT FOR AVERAGING CANDLE";
    }
  } else if (significant) action = "SIGNIFICANT_EVENT — add breakout context to get a decision";

  return {
    ticker: entity.ticker,
    as_of: asOfClamped.toISOString(),
    mode: breakout ? "BREAKOUT_DECISION" : "LIVE_EVENT_SCAN",
    historical_replay: historical,
    entity,
    primary_catalyst: {
      ...classification,
      source_type: primaryEv?.source_type ?? null,
      source_url: primaryEv?.source_url ?? null,
    },
    freshness,
    hours_since_event: hoursSince,
    significant_event_now: significant,
    market_context: market,
    insider,
    breakout,
    raw_score: raw,
    score_components: components,
    probability_no_averaging: probability,
    probability_basis: conflict ? "Suppressed: high-authority sources disagree" : basis,
    confidence,
    confidence_breakdown: breakdown,
    status,
    action,
    system_state: systemState,
    evidence,
    filings: filings.slice(0, 40).map((f) => ({
      form: f.form,
      filed_at: f.acceptedAt,
      description: f.description,
      url: f.url,
    })),
    fda: fdaEvidence,
    warnings,
    audit: {
      model_version: classification.engine === "claude" ? classification.model ?? CLAUDE_MODEL : "rules",
      skill_version: SKILL_VERSION,
      scoring_version: SCORING_VERSION,
      calibration_version: CALIBRATION_VERSION,
      input_timestamp: now.toISOString(),
      source_timestamps: evidence.map((e) => e.first_public_timestamp),
      run_ms: Date.now() - t0,
    },
  };
}
