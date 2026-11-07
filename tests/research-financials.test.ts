import { describe, expect, it } from "vitest";
import { annualSeries, buildFinancialEvidence, CONCEPTS, filingUrl, quarterlySeries } from "@/lib/research/sec-financials";
import { FACTS } from "./fixtures/companyfacts";

const asOf = new Date("2026-11-07T16:00:00Z");
const byKey = (ev: ReturnType<typeof buildFinancialEvidence>["evidence"], prefix: string) => ev.find((e) => e.event_key.startsWith(prefix));

describe("XBRL series", () => {
  it("keeps only 12-month 10-K durations for annual series", () => {
    expect(annualSeries(FACTS, CONCEPTS.revenue, asOf).map((p) => p.val)).toEqual([1000e6, 1200e6, 1500e6, 2100e6]);
  });
  it("is point-in-time: excludes facts filed after as_of", () => {
    expect(quarterlySeries(FACTS, CONCEPTS.revenue, asOf).at(-1)?.end).toBe("2026-07-31"); // Q filed 2026-11-28 is in the future
    expect(annualSeries(FACTS, CONCEPTS.revenue, new Date("2025-06-01")).at(-1)?.end).toBe("2025-01-31");
  });
});

describe("buildFinancialEvidence", () => {
  const r = buildFinancialEvidence(FACTS, asOf, 36, "2026-11-07T16:00:00.000Z");

  it("reports annual revenue growth with acceleration and CAGR", () => {
    const e = byKey(r.evidence, "fin-revenue")!;
    expect(e.direction).toBe("BULLISH");
    expect(e.metrics).toMatchObject({ growth_pct: 40, prior_growth_pct: 25 });
    expect(e.claim).toContain("$2.10B");
    expect(e.claim).toContain("accelerated");
  });

  it("computes quarterly YoY growth from comparable quarters", () => {
    const e = byKey(r.evidence, "fin-qrevenue")!;
    expect(e.metrics?.yoy_pct).toBeCloseTo(33.3, 1);
  });

  it("detects operating-margin expansion", () => {
    const e = byKey(r.evidence, "fin-opmargin")!;
    expect(e.direction).toBe("BULLISH");
    expect(e.metrics).toMatchObject({ margin_pct: 15, prior_margin_pct: 10, change_pp: 5 });
  });

  it("flags dilution and rising leverage as bearish", () => {
    expect(byKey(r.evidence, "fin-shares")!.direction).toBe("BEARISH");
    const bal = byKey(r.evidence, "fin-balance")!;
    expect(bal.metrics).toMatchObject({ debt_change_pct: 100 });
    expect(bal.direction).toBe("BEARISH");
  });

  it("recognizes a swing to profitability and computes free cash flow", () => {
    expect(byKey(r.evidence, "fin-netincome")!.claim).toContain("turned profitable");
    expect(byKey(r.evidence, "fin-fcf")!.metrics).toMatchObject({ free_cash_flow: 400e6 });
  });

  it("links every evidence item to a dated SEC filing source", () => {
    const ids = new Set(r.sources.map((s) => s.id));
    for (const e of r.evidence) {
      expect(e.verification).toBe("confirmed_fact");
      expect(e.source_ids.length).toBeGreaterThan(0);
      for (const id of e.source_ids) expect(ids.has(id)).toBe(true);
    }
    const s = r.sources[0];
    expect(s.url).toBe(filingUrl(1, s.id.replace(/^sec-/, "")));
    expect(s.published_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
