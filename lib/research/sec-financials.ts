import { secJson } from "../http";
import type { Direction, Level, ResearchEvidence, ResearchSource } from "./types";

/**
 * Skill 2 — SEC Filing Research.
 * Builds period-over-period financial evidence from SEC XBRL company facts.
 * Every number is tied to the filing (accession) that first reported it and to
 * its reporting period, and only facts filed on or before `asOf` are used.
 */

export interface XbrlFact {
  start?: string;
  end: string;
  val: number;
  accn: string;
  fy: number | null;
  fp: string | null;
  form: string;
  filed: string; // YYYY-MM-DD
  frame?: string;
}

export interface CompanyFacts {
  cik: number;
  entityName: string;
  facts: Record<string, Record<string, { label?: string; units: Record<string, XbrlFact[]> }>>;
}

export interface Point {
  end: string;
  start?: string;
  val: number;
  accn: string;
  form: string;
  filed: string;
}

const DAY = 86400_000;
const days = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / DAY;

export const CONCEPTS = {
  revenue: [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "Revenues",
    "SalesRevenueNet",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
  ],
  grossProfit: ["GrossProfit"],
  operatingIncome: ["OperatingIncomeLoss"],
  operatingExpenses: ["OperatingExpenses", "CostsAndExpenses"],
  netIncome: ["NetIncomeLoss", "ProfitLoss"],
  cfo: ["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"],
  capex: ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"],
  dilutedShares: ["WeightedAverageNumberOfDilutedSharesOutstanding"],
  longTermDebt: ["LongTermDebtNoncurrent", "LongTermDebt"],
  cash: ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"],
} as const;

function factsFor(cf: CompanyFacts, concept: string, unit: string): XbrlFact[] {
  return cf.facts["us-gaap"]?.[concept]?.units?.[unit] ?? [];
}

/** Annual (≈12-month) duration values, one per fiscal-year end, as known at `asOf`. */
export function annualSeries(cf: CompanyFacts, concepts: readonly string[], asOf: Date, unit = "USD"): Point[] {
  return pickBest(cf, concepts, asOf, unit, (f) => !!f.start && days(f.start, f.end) > 340 && days(f.start, f.end) < 390 && /^10-K/.test(f.form));
}

/** Quarterly (≈3-month) duration values from 10-Qs, as known at `asOf`. */
export function quarterlySeries(cf: CompanyFacts, concepts: readonly string[], asOf: Date, unit = "USD"): Point[] {
  return pickBest(cf, concepts, asOf, unit, (f) => !!f.start && days(f.start, f.end) > 80 && days(f.start, f.end) < 100 && /^10-Q/.test(f.form));
}

/** Point-in-time balance-sheet values reported in 10-K/10-Q. */
export function instantSeries(cf: CompanyFacts, concepts: readonly string[], asOf: Date, unit = "USD"): Point[] {
  return pickBest(cf, concepts, asOf, unit, (f) => !f.start && /^10-[KQ]/.test(f.form));
}

function pickBest(cf: CompanyFacts, concepts: readonly string[], asOf: Date, unit: string, keep: (f: XbrlFact) => boolean): Point[] {
  const cutoff = asOf.toISOString().slice(0, 10);
  let best: Point[] = [];
  for (const c of concepts) {
    const byEnd = new Map<string, XbrlFact>();
    for (const f of factsFor(cf, c, unit)) {
      if (f.filed > cutoff || !keep(f)) continue; // point-in-time
      const prev = byEnd.get(f.end);
      // the first filing that reported the period is what the market saw first;
      // later restatements replace it only once they were themselves filed (already gated by cutoff)
      if (!prev || f.filed > prev.filed) byEnd.set(f.end, f);
    }
    const pts = [...byEnd.values()]
      .map((f) => ({ end: f.end, start: f.start, val: f.val, accn: f.accn, form: f.form, filed: f.filed }))
      .sort((a, b) => a.end.localeCompare(b.end));
    // prefer the concept with the most recent data, then the longest history
    const bestEnd = best.at(-1)?.end ?? "";
    const ptsEnd = pts.at(-1)?.end ?? "";
    if (ptsEnd > bestEnd || (ptsEnd === bestEnd && pts.length > best.length)) best = pts;
  }
  return best;
}

export const pct = (a: number, b: number) => (b !== 0 ? ((a - b) / Math.abs(b)) * 100 : null);
const fmtPct = (x: number | null, d = 1) => (x === null ? "n/a" : `${x >= 0 ? "+" : ""}${x.toFixed(d)}%`);
export const fmtUsd = (x: number) => {
  const a = Math.abs(x);
  const s = a >= 1e9 ? `$${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `$${(a / 1e6).toFixed(1)}M` : `$${a.toFixed(0)}`;
  return x < 0 ? `-${s}` : s;
};

export function filingUrl(cik: number | string, accn: string) {
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accn.replace(/-/g, "")}/${accn}-index.htm`;
}

export interface FinancialResearch {
  evidence: ResearchEvidence[];
  sources: ResearchSource[];
  periods: { annual: string[]; latestQuarter: string | null };
  notes: string[];
}

export function buildFinancialEvidence(cf: CompanyFacts, asOf: Date, months = 36, retrievedAt = new Date().toISOString()): FinancialResearch {
  const cik = cf.cik;
  const minEnd = new Date(asOf.getTime() - (months + 12) * 30.44 * DAY).toISOString().slice(0, 10);
  const within = (s: Point[]) => s.filter((p) => p.end >= minEnd);
  const sources = new Map<string, ResearchSource>();
  const evidence: ResearchEvidence[] = [];
  const notes: string[] = [];

  const src = (p: Point, label: string): string => {
    const id = `sec-${p.accn}`;
    if (!sources.has(id)) {
      sources.set(id, {
        id,
        url: filingUrl(cik, p.accn),
        title: `${p.form} — ${cf.entityName} (period ended ${p.end})`,
        provider: "SEC EDGAR",
        kind: "sec_filing",
        channel: "sec",
        published_at: `${p.filed}T21:00:00.000Z`,
        retrieved_at: retrievedAt,
        form: p.form,
        period: label,
      });
    }
    return id;
  };
  const fy = (p: Point) => `FY ended ${p.end}`;
  const add = (e: Omit<ResearchEvidence, "id" | "channel" | "verification">) =>
    evidence.push({ ...e, id: `fin-${evidence.length + 1}`, channel: "sec", verification: "confirmed_fact" });

  const rev = within(annualSeries(cf, CONCEPTS.revenue, asOf));
  const op = annualSeries(cf, CONCEPTS.operatingIncome, asOf);
  const gp = annualSeries(cf, CONCEPTS.grossProfit, asOf);
  const ni = annualSeries(cf, CONCEPTS.netIncome, asOf);
  const opex = annualSeries(cf, CONCEPTS.operatingExpenses, asOf);
  const cfo = annualSeries(cf, CONCEPTS.cfo, asOf);
  const capex = annualSeries(cf, CONCEPTS.capex, asOf);
  const sh = annualSeries(cf, CONCEPTS.dilutedShares, asOf, "shares");
  const debt = instantSeries(cf, CONCEPTS.longTermDebt, asOf);
  const cash = instantSeries(cf, CONCEPTS.cash, asOf);
  const at = (s: Point[], end: string) => s.find((p) => p.end === end);

  // 1. Annual revenue trend
  if (rev.length >= 2) {
    const last = rev.at(-1)!;
    const prev = rev.at(-2)!;
    const g = pct(last.val, prev.val)!;
    const first = rev[Math.max(0, rev.length - 4)];
    const yrs = Math.max(1, Math.round(days(first.end, last.end) / 365));
    const cagr = first.val > 0 && last.val > 0 && first !== last ? (Math.pow(last.val / first.val, 1 / yrs) - 1) * 100 : null;
    const priorG = rev.length >= 3 ? pct(prev.val, rev.at(-3)!.val) : null;
    const dir: Direction = g >= 10 ? "BULLISH" : g < 0 ? "BEARISH" : g < 3 ? "MIXED" : "NEUTRAL";
    add({
      source_ids: [src(last, fy(last)), src(prev, fy(prev))],
      claim: `Annual revenue was ${fmtUsd(last.val)} for the ${fy(last)}, ${fmtPct(g)} versus ${fmtUsd(prev.val)} the prior year${priorG !== null ? ` (prior-year growth ${fmtPct(priorG)}, so growth ${g > priorG ? "accelerated" : "decelerated"})` : ""}${cagr !== null && yrs > 1 ? `; ${yrs}-year CAGR ${fmtPct(cagr)}` : ""}.`,
      direction: dir,
      materiality: "high",
      horizon: "long_term",
      event_key: `fin-revenue-${last.end}`,
      published_at: `${last.filed}T21:00:00.000Z`,
      metrics: { revenue: last.val, prior_revenue: prev.val, growth_pct: round(g), prior_growth_pct: priorG === null ? null : round(priorG), cagr_pct: cagr === null ? null : round(cagr) },
    });
  } else notes.push("Annual revenue series unavailable in XBRL company facts.");

  // 2. Latest quarter YoY revenue growth and acceleration
  const q = quarterlySeries(cf, CONCEPTS.revenue, asOf);
  const lastQ = q.at(-1);
  const yoy = (p: Point | undefined) => {
    if (!p) return null;
    const target = Date.parse(p.end) - 365 * DAY;
    const cmp = q.find((x) => Math.abs(Date.parse(x.end) - target) < 20 * DAY);
    return cmp ? { cmp, g: pct(p.val, cmp.val)! } : null;
  };
  const yq = yoy(lastQ);
  if (lastQ && yq) {
    const prevQ = q.at(-2);
    const yqPrev = yoy(prevQ);
    const accel = yqPrev ? yq.g - yqPrev.g : null;
    const dir: Direction = yq.g >= 10 && (accel ?? 0) >= -5 ? "BULLISH" : yq.g < 0 || (accel !== null && accel < -10) ? "BEARISH" : "MIXED";
    add({
      source_ids: [src(lastQ, `quarter ended ${lastQ.end}`), src(yq.cmp, `quarter ended ${yq.cmp.end}`)],
      claim: `Quarterly revenue for the period ended ${lastQ.end} was ${fmtUsd(lastQ.val)}, ${fmtPct(yq.g)} year over year${accel !== null ? ` (${accel >= 0 ? "acceleration" : "deceleration"} of ${Math.abs(accel).toFixed(1)} pp versus the prior quarter's ${fmtPct(yqPrev!.g)})` : ""}.`,
      direction: dir,
      materiality: "high",
      horizon: "medium_term",
      event_key: `fin-qrevenue-${lastQ.end}`,
      published_at: `${lastQ.filed}T21:00:00.000Z`,
      metrics: { quarter_revenue: lastQ.val, yoy_pct: round(yq.g), acceleration_pp: accel === null ? null : round(accel) },
    });
  }

  // 3. Margins (operating, gross) — latest FY vs prior FY
  const marginEvidence = (num: Point[], label: string, key: string, threshold: number) => {
    if (rev.length < 2) return;
    const last = rev.at(-1)!;
    const prev = rev.at(-2)!;
    const a = at(num, last.end);
    const b = at(num, prev.end);
    if (!a || !b) return;
    const m1 = (a.val / last.val) * 100;
    const m0 = (b.val / prev.val) * 100;
    const d = m1 - m0;
    add({
      source_ids: [src(a, fy(a)), src(b, fy(b))],
      claim: `${label} was ${m1.toFixed(1)}% in the ${fy(last)} versus ${m0.toFixed(1)}% a year earlier (${d >= 0 ? "+" : ""}${d.toFixed(1)} pp).`,
      direction: d >= threshold ? "BULLISH" : d <= -threshold ? "BEARISH" : "NEUTRAL",
      materiality: Math.abs(d) >= threshold * 2 ? "high" : "medium",
      horizon: "medium_term",
      event_key: `fin-${key}-${last.end}`,
      published_at: `${a.filed}T21:00:00.000Z`,
      metrics: { margin_pct: round(m1), prior_margin_pct: round(m0), change_pp: round(d) },
    });
  };
  marginEvidence(op, "Operating margin", "opmargin", 2);
  marginEvidence(gp, "Gross margin", "grossmargin", 1.5);

  // 4. Operating expenses growing faster than revenue
  if (rev.length >= 2) {
    const last = rev.at(-1)!;
    const prev = rev.at(-2)!;
    const a = at(opex, last.end);
    const b = at(opex, prev.end);
    if (a && b) {
      const og = pct(a.val, b.val)!;
      const rg = pct(last.val, prev.val)!;
      const gap = og - rg;
      if (Math.abs(gap) >= 3) {
        add({
          source_ids: [src(a, fy(a)), src(b, fy(b))],
          claim: `Operating costs grew ${fmtPct(og)} while revenue grew ${fmtPct(rg)} in the ${fy(last)} — costs ${gap > 0 ? "outpaced" : "lagged"} revenue by ${Math.abs(gap).toFixed(1)} pp.`,
          direction: gap > 0 ? "BEARISH" : "BULLISH",
          materiality: Math.abs(gap) >= 10 ? "high" : "medium",
          horizon: "medium_term",
          event_key: `fin-opex-${last.end}`,
          published_at: `${a.filed}T21:00:00.000Z`,
          metrics: { opex_growth_pct: round(og), revenue_growth_pct: round(rg), gap_pp: round(gap) },
        });
      }
    }
  }

  // 5. Net income
  if (ni.length >= 2) {
    const a = ni.at(-1)!;
    const b = ni.at(-2)!;
    const turned = a.val > 0 && b.val <= 0 ? "turned profitable" : a.val <= 0 && b.val > 0 ? "swung to a loss" : null;
    const g = pct(a.val, b.val);
    add({
      source_ids: [src(a, fy(a)), src(b, fy(b))],
      claim: `Net income was ${fmtUsd(a.val)} in the ${fy(a)} versus ${fmtUsd(b.val)} the prior year${turned ? ` — the company ${turned}` : g !== null ? ` (${fmtPct(g)})` : ""}.`,
      direction: a.val > 0 && (g ?? 0) > 10 ? "BULLISH" : a.val <= 0 || (g ?? 0) < -10 ? "BEARISH" : "NEUTRAL",
      materiality: turned ? "high" : "medium",
      horizon: "medium_term",
      event_key: `fin-netincome-${a.end}`,
      published_at: `${a.filed}T21:00:00.000Z`,
      metrics: { net_income: a.val, prior_net_income: b.val },
    });
  }

  // 6. Free cash flow
  const lastCfo = cfo.at(-1);
  if (lastCfo) {
    const cx = at(capex, lastCfo.end);
    const r = at(rev, lastCfo.end);
    const fcf = lastCfo.val - (cx?.val ?? 0);
    const margin = r ? (fcf / r.val) * 100 : null;
    add({
      source_ids: [src(lastCfo, fy(lastCfo))],
      claim: `Operating cash flow was ${fmtUsd(lastCfo.val)}${cx ? ` and capital expenditure ${fmtUsd(cx.val)}, leaving free cash flow of ${fmtUsd(fcf)}` : ""} in the ${fy(lastCfo)}${margin !== null ? ` (${margin.toFixed(1)}% of revenue)` : ""}.`,
      direction: fcf < 0 ? "BEARISH" : margin !== null && margin >= 15 ? "BULLISH" : "NEUTRAL",
      materiality: fcf < 0 || (margin ?? 0) >= 25 ? "high" : "medium",
      horizon: "long_term",
      event_key: `fin-fcf-${lastCfo.end}`,
      published_at: `${lastCfo.filed}T21:00:00.000Z`,
      metrics: { operating_cash_flow: lastCfo.val, capex: cx?.val ?? null, free_cash_flow: fcf, fcf_margin_pct: margin === null ? null : round(margin) },
    });
  }

  // 7. Dilution / buybacks
  if (sh.length >= 2) {
    const a = sh.at(-1)!;
    const b = sh.at(-2)!;
    const g = pct(a.val, b.val)!;
    if (Math.abs(g) >= 1) {
      add({
        source_ids: [src(a, fy(a)), src(b, fy(b))],
        claim: `Weighted diluted share count ${g > 0 ? "rose" : "fell"} ${Math.abs(g).toFixed(1)}% year over year in the ${fy(a)} (${(a.val / 1e6).toFixed(1)}M vs ${(b.val / 1e6).toFixed(1)}M)${g > 0 ? ", diluting existing holders" : ", consistent with net share repurchases"}.`,
        direction: g >= 3 ? "BEARISH" : g <= -1 ? "BULLISH" : "NEUTRAL",
        materiality: Math.abs(g) >= 5 ? "high" : "medium",
        horizon: "long_term",
        event_key: `fin-shares-${a.end}`,
        published_at: `${a.filed}T21:00:00.000Z`,
        metrics: { diluted_shares: a.val, prior_diluted_shares: b.val, change_pct: round(g) },
      });
    }
  }

  // 8. Balance sheet: debt vs cash
  const lastDebt = debt.at(-1);
  const lastCash = cash.at(-1);
  if (lastCash) {
    const d = lastDebt && Math.abs(days(lastDebt.end, lastCash.end)) < 5 ? lastDebt : undefined;
    const prevDebt = d ? debt.filter((p) => days(p.end, d.end) > 300).at(-1) : undefined;
    const debtGrowth = d && prevDebt ? pct(d.val, prevDebt.val) : null;
    const net = lastCash.val - (d?.val ?? 0);
    add({
      source_ids: [src(lastCash, `balance sheet ${lastCash.end}`), ...(d ? [src(d, `balance sheet ${d.end}`)] : [])],
      claim: `As of ${lastCash.end}, cash and equivalents were ${fmtUsd(lastCash.val)}${d ? ` against long-term debt of ${fmtUsd(d.val)} (net ${net >= 0 ? "cash" : "debt"} ${fmtUsd(Math.abs(net))})` : ""}${debtGrowth !== null ? `; long-term debt changed ${fmtPct(debtGrowth)} over the past year` : ""}.`,
      direction: net >= 0 && (debtGrowth ?? 0) < 25 ? "BULLISH" : (debtGrowth ?? 0) >= 25 || net < 0 ? "BEARISH" : "NEUTRAL",
      materiality: (debtGrowth ?? 0) >= 50 ? "high" : "medium",
      horizon: "long_term",
      event_key: `fin-balance-${lastCash.end}`,
      published_at: `${lastCash.filed}T21:00:00.000Z`,
      metrics: { cash: lastCash.val, long_term_debt: d?.val ?? null, net_cash: net, debt_change_pct: debtGrowth === null ? null : round(debtGrowth) },
    });
  }

  return {
    evidence,
    sources: [...sources.values()],
    periods: { annual: rev.map((p) => p.end), latestQuarter: lastQ?.end ?? null },
    notes,
  };
}

const round = (x: number) => Math.round(x * 10) / 10;

export async function fetchCompanyFacts(cik: string): Promise<CompanyFacts> {
  return secJson<CompanyFacts>(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`);
}

export type { Level };
