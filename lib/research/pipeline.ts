import { listFilings, resolveEntity } from "../sec";
import { CostMeter, hasClaude, PROMPT_VERSION, RESEARCH_MODEL, withCostMeter } from "./claude";
import { buildFinancialEvidence, fetchCompanyFacts } from "./sec-financials";
import { researchStrategy, selectReleases } from "./strategy";
import { CHANNEL_DOMAINS, researchChannel } from "./news";
import { fallbackSummary, rulesAnalyst, runAnalyst, writeSummary, type AnalystOutput } from "./analysts";
import { compose } from "./validator";
import { getStore } from "./store";
import type { AnalysisOptions, BullBearAnalysis, Channel, ChannelCoverage, ResearchEvidence, ResearchSource } from "./types";

export const PIPELINE_VERSION = "bull-bear-pipeline@1.1.0";

export type ProgressStatus = "pending" | "running" | "done" | "failed" | "skipped";
export interface PipelineHooks {
  onProgress?: (channel: Channel | "analysis", status: ProgressStatus) => void | Promise<void>;
}
const MONTH = 30.44 * 86400e3;

export function newAnalysis(id: string, ticker: string, asOf: Date, options: AnalysisOptions): BullBearAnalysis {
  const now = new Date().toISOString();
  return {
    analysis_id: id,
    ticker: ticker.toUpperCase(),
    company_name: null,
    cik: null,
    as_of: asOf.toISOString(),
    created_at: now,
    completed_at: null,
    status: "queued",
    options,
    bullish_arguments: [],
    bearish_arguments: [],
    insufficient: { bullish: false, bearish: false },
    evidence: [],
    sources: [],
    conflicts: [],
    coverage: [],
    data_quality: { research_complete: false, freshness: "unknown", last_successful_update: null, missing_sources: [], warnings: [] },
    audit: { engine: hasClaude() ? "claude" : "rules", model: hasClaude() ? RESEARCH_MODEL : null, prompt_version: PROMPT_VERSION, pipeline_version: PIPELINE_VERSION, run_ms: null },
  };
}

/** Run the full research pipeline for a queued analysis and persist the result. */
export async function runBullBear(initial: BullBearAnalysis, hooks: PipelineHooks = {}): Promise<BullBearAnalysis> {
  const t0 = Date.now();
  const store = getStore();
  const a: BullBearAnalysis = { ...initial, status: "running" };
  await store.save(a);
  const meter = new CostMeter();
  try {
    const result = await withCostMeter(meter, () => research(a, hooks));
    Object.assign(a, result, { status: "completed", completed_at: new Date().toISOString() });
  } catch (e) {
    a.status = "failed";
    a.error = (e as Error).message;
    a.completed_at = new Date().toISOString();
  }
  a.audit.run_ms = Date.now() - t0;
  a.cost_usd = Math.round(meter.usd * 10000) / 10000;
  console.log(JSON.stringify({ evt: "bull_bear_run", ticker: a.ticker, status: a.status, run_ms: a.audit.run_ms, cost_usd: a.cost_usd, llm_calls: meter.calls, coverage: a.coverage.map((c) => `${c.channel}:${c.status}`) }));
  await store.save(a);
  return a;
}

async function research(a: BullBearAnalysis, hooks: PipelineHooks): Promise<Partial<BullBearAnalysis>> {
  const o = a.options;
  const lang = o.language;
  const progress = async (ch: Channel | "analysis", st: ProgressStatus) => {
    try {
      await hooks.onProgress?.(ch, st);
    } catch {
      /* progress reporting must never break the run */
    }
  };
  const asOf = new Date(a.as_of);
  const historical = Date.now() - asOf.getTime() > 6 * 3600e3;
  const retrievedAt = new Date().toISOString();
  const useClaude = hasClaude();
  const warnings: string[] = [];
  const missing: string[] = [];
  const coverage: ChannelCoverage[] = [];
  const histFrom = new Date(asOf.getTime() - o.company_history_months * MONTH).toISOString().slice(0, 10);
  const mediaFrom = new Date(asOf.getTime() - o.recent_media_months * MONTH).toISOString().slice(0, 10);
  const to = asOf.toISOString().slice(0, 10);

  const { entity, submissions } = await resolveEntity(a.ticker);
  a.company_name = entity.company_name;
  a.cik = entity.cik;
  const filings = listFilings(submissions, asOf, Math.round(o.company_history_months * 30.44));
  let scanned = filings.length;
  // History available: older filing pages mean the full window is covered.
  const recent = submissions.filings.recent;
  const oldest = recent.filingDate.length ? recent.filingDate[recent.filingDate.length - 1] : null;
  const historyMonths = submissions.filings.files?.length || !oldest
    ? o.company_history_months
    : Math.min(o.company_history_months, Math.max(0, Math.round((asOf.getTime() - Date.parse(oldest)) / MONTH)));
  const material = filings.find((f) => /^(8-K|6-K|SC TO|SC 14D9|425)/.test(f.form) && asOf.getTime() - Date.parse(f.acceptedAt) <= 24 * 3600e3);

  let evidence: ResearchEvidence[] = [];
  let sources: ResearchSource[] = [];

  // Skill 2 — SEC filings (also feeds Skill 1's outcome checks)
  if (o.include_sec) {
    await progress("sec", "running");
    try {
      const facts = await fetchCompanyFacts(entity.cik);
      const fin = buildFinancialEvidence(facts, asOf, o.company_history_months, retrievedAt);
      evidence.push(...fin.evidence);
      sources.push(...fin.sources);
      const counts = ["10-K", "10-Q", "8-K"].map((f) => `${filings.filter((x) => x.form.startsWith(f)).length} ${f}`).join(", ");
      await progress("sec", "done");
      coverage.push({ channel: "sec", requested: true, status: fin.evidence.length ? "ok" : "partial", window: { from: histFrom, to }, items: fin.evidence.length, scanned: filings.length, note: `${counts} in window; XBRL periods ${fin.periods.annual.join(", ") || "none"}. Risk-factor text comparison is not yet automated.${fin.notes.length ? " " + fin.notes.join(" ") : ""}` });
    } catch (e) {
      await progress("sec", "failed");
      coverage.push({ channel: "sec", requested: true, status: "error", window: { from: histFrom, to }, items: 0, note: (e as Error).message });
      missing.push("SEC XBRL financial data");
    }
  } else coverage.push({ channel: "sec", requested: false, status: "skipped", window: { from: histFrom, to }, items: 0 });

  // Skill 1 (strategy) and Skill 3 (news/social) run in parallel
  const tasks: Promise<void>[] = [];
  if (o.include_strategy) {
    const releases = selectReleases(filings);
    await progress("strategy", "running");
    tasks.push(
      researchStrategy({ releases, company: entity.company_name, ticker: a.ticker, asOf, financialEvidence: evidence.slice(), retrievedAt, useClaude, language: lang })
        .then(async (r) => {
          await progress("strategy", r.status === "error" ? "failed" : "done");
          evidence.push(...r.evidence);
          sources.push(...r.sources);
          coverage.push({ channel: "strategy", requested: true, status: r.status, window: { from: histFrom, to }, items: r.evidence.length, scanned: releases.length, note: r.note });
          missing.push("Earnings-call transcripts (licensed; not available from free official sources)");
        })
        .catch(async (e) => {
          await progress("strategy", "failed");
          coverage.push({ channel: "strategy", requested: true, status: "error", window: { from: histFrom, to }, items: 0, note: (e as Error).message });
        }),
    );
  } else coverage.push({ channel: "strategy", requested: false, status: "skipped", window: { from: histFrom, to }, items: 0 });

  const channels: [keyof typeof CHANNEL_DOMAINS, boolean][] = [
    ["news", o.include_news],
    ["youtube", o.include_youtube],
    ["x", o.include_x],
    ["instagram", o.include_instagram],
  ];
  for (const [ch, on] of channels) {
    const days = ch === "news" ? o.news_days : o.social_days;
    const chFrom = days ? new Date(asOf.getTime() - days * 86400e3).toISOString().slice(0, 10) : mediaFrom;
    if (!on) {
      await progress(ch, "skipped");
      coverage.push({ channel: ch, requested: false, status: "skipped", window: { from: chFrom, to }, items: 0 });
      continue;
    }
    if (!useClaude) {
      await progress(ch, "skipped");
      coverage.push({ channel: ch, requested: true, status: "unavailable", window: { from: chFrom, to }, items: 0, note: "Requires the Claude research layer with web search (set ANTHROPIC_API_KEY)." });
      missing.push(`${ch} (research layer not configured)`);
      continue;
    }
    await progress(ch, "running");
    tasks.push(
      researchChannel({ channel: ch, company: entity.company_name, ticker: a.ticker, aliases: [], asOf, months: o.recent_media_months, days, historical, retrievedAt })
        .then(async (r) => {
          await progress(ch, r.coverage.status === "error" ? "failed" : "done");
          scanned += r.coverage.scanned ?? 0;
          evidence.push(...r.evidence);
          sources.push(...r.sources);
          coverage.push(r.coverage);
          if (r.coverage.status === "unavailable" || r.coverage.status === "error") missing.push(`${ch}: ${r.coverage.note ?? r.coverage.status}`);
        })
        .catch(async (e) => {
          await progress(ch, "failed");
          coverage.push({ channel: ch, requested: true, status: "error", window: { from: chFrom, to }, items: 0, note: (e as Error).message });
          missing.push(`${ch}: ${(e as Error).message}`);
        }),
    );
  }
  await Promise.all(tasks);

  // point-in-time guard across all channels (Rule 6)
  const before = evidence.length;
  evidence = evidence.filter((e) => !e.published_at || Date.parse(e.published_at) <= asOf.getTime() + 60_000);
  if (evidence.length < before) warnings.push(`${before - evidence.length} evidence item(s) published after as_of were excluded.`);
  if (historical) warnings.push("Historical replay: web search cannot guarantee point-in-time completeness; undated items were excluded.");

  // Skills 4 & 5 — independent analysts over the same evidence
  await progress("analysis", "running");
  let bullish: AnalystOutput;
  let bearish: AnalystOutput;
  if (useClaude && evidence.length) {
    const r = await Promise.allSettled([
      runAnalyst("bullish", { company: entity.company_name, ticker: a.ticker, asOf, evidence, language: lang }),
      runAnalyst("bearish", { company: entity.company_name, ticker: a.ticker, asOf, evidence, language: lang }),
    ]);
    bullish = r[0].status === "fulfilled" ? r[0].value : (warnings.push(`Bullish analyst failed: ${(r[0] as PromiseRejectedResult).reason}`), rulesAnalyst("bullish", evidence));
    bearish = r[1].status === "fulfilled" ? r[1].value : (warnings.push(`Bearish analyst failed: ${(r[1] as PromiseRejectedResult).reason}`), rulesAnalyst("bearish", evidence));
  } else {
    if (!useClaude) warnings.push("Claude research layer not configured — arguments are derived only from reported SEC financials.");
    bullish = rulesAnalyst("bullish", evidence);
    bearish = rulesAnalyst("bearish", evidence);
  }

  // Skill 6 — validate & compose
  const c = compose({ bullish, bearish, evidence, sources, asOf });
  warnings.push(...c.warnings);
  let summary = fallbackSummary(c.bullish_arguments, c.bearish_arguments, lang);
  if (useClaude && (c.bullish_arguments.length || c.bearish_arguments.length)) {
    try {
      summary = await writeSummary({ company: entity.company_name, ticker: a.ticker, bull: c.bullish_arguments.slice(0, 7), bear: c.bearish_arguments.slice(0, 7), language: lang });
    } catch (e) {
      warnings.push(`Summary writer failed (${(e as Error).message}); used a deterministic summary.`);
    }
  }
  await progress("analysis", "done");
  const requested = coverage.filter((x) => x.requested);
  const complete = requested.length > 0 && requested.every((x) => x.status === "ok");
  const latest = evidence.map((e) => e.published_at).filter(Boolean).sort().at(-1) ?? null;
  const freshness = latest ? (asOf.getTime() - Date.parse(latest) < 14 * 86400e3 ? "fresh" : "stale") : "unknown";

  return {
    company_name: entity.company_name,
    cik: entity.cik,
    bullish_arguments: c.bullish_arguments,
    bearish_arguments: c.bearish_arguments,
    insufficient: c.insufficient,
    evidence,
    sources: c.sources,
    conflicts: c.conflicts,
    coverage,
    data_quality: {
      research_complete: complete,
      freshness,
      last_successful_update: new Date().toISOString(),
      missing_sources: [...new Set(missing)],
      warnings,
    },
    summary,
    sources_scanned: scanned,
    history_months: historyMonths,
    recent_material_event_at: material?.acceptedAt ?? null,
  };
}
