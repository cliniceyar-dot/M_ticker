import { describe, expect, it } from "vitest";
import { computeConfidence, computeRawScore, evThreshold, seedProbability } from "@/lib/scoring";
import { classification, market, noInsiders } from "./helpers";

describe("computeRawScore", () => {
  it("scores a fresh, official, sector-independent catalyst highly", () => {
    const { raw, components } = computeRawScore({ c: classification(), sourceType: "SEC_FILING", m: market(), insider: noInsiders(), hoursSinceEvent: 2 });
    expect(components).toHaveLength(10);
    expect(raw).toBeGreaterThan(70);
    for (const c of components) {
      expect(c.value).toBeGreaterThanOrEqual(0);
      expect(c.value).toBeLessThanOrEqual(c.max);
    }
  });

  it("penalizes stale materializations", () => {
    const fresh = computeRawScore({ c: classification(), sourceType: "SEC_FILING", m: market(), insider: noInsiders(), hoursSinceEvent: 2 }).raw;
    const stale = computeRawScore({ c: classification({ new_or_materialization: "MATERIALIZATION" }), sourceType: "SEC_FILING", m: market(), insider: noInsiders(), hoursSinceEvent: 130 }).raw;
    expect(stale).toBeLessThanOrEqual(fresh - 15);
  });

  it("applies the full contradiction penalty for high-authority conflicts", () => {
    const { components } = computeRawScore({ c: classification({ high_authority_conflict: true, conflicts: ["FDA approval vs pending"] }), sourceType: "SEC_FILING", m: market(), insider: noInsiders(), hoursSinceEvent: 2 });
    expect(components.find((c) => c.key === "contradiction")?.value).toBe(15);
  });

  it("stays within 0–100 with no market data", () => {
    const { raw } = computeRawScore({ c: classification({ catalyst_strength: 0, novelty_score: 0, surprise: 0, certainty: 0 }), sourceType: null, m: market({ available: false, stock_move_pct: null, relative_volume: null, relative_return_to_sector: null }), insider: noInsiders(), hoursSinceEvent: null });
    expect(raw).toBe(0);
  });
});

describe("seedProbability", () => {
  it("is monotonic in the raw score and clamped to [0.05, 0.9]", () => {
    const m = market({ gap_vs_atr: 1 });
    const ps = [0, 30, 55, 80, 100].map((r) => seedProbability(r, m, null).p);
    for (let i = 1; i < ps.length; i++) expect(ps[i]).toBeGreaterThan(ps[i - 1]);
    expect(ps[0]).toBeGreaterThanOrEqual(0.05);
    expect(ps[4]).toBeLessThanOrEqual(0.9);
    expect(seedProbability(55, m, null).p).toBeCloseTo(0.5, 5);
  });

  it("nudges PEAK up, BOTTOM down and over-extended gaps down", () => {
    const m = market({ gap_vs_atr: 1 });
    const base = seedProbability(60, m, null).p;
    const b = (pattern: "PEAK" | "BOTTOM") => ({ confirmed_by_user: true, pattern, breakout_date: "2026-11-06", breakout_high: 35 });
    expect(seedProbability(60, m, b("PEAK")).p).toBeGreaterThan(base);
    expect(seedProbability(60, m, b("BOTTOM")).p).toBeLessThan(base);
    expect(seedProbability(60, market({ gap_vs_atr: 4 }), null).p).toBeLessThan(base);
  });

  it("labels the result as uncalibrated", () => {
    expect(seedProbability(60, market(), null).basis).toMatch(/UNCALIBRATED/);
  });
});

describe("computeConfidence", () => {
  it("is high with official sources and full data", () => {
    const { confidence } = computeConfidence({ entityOk: true, m: market(), filingsOk: true, c: classification({ engine: "claude" }), sourceType: "SEC_FILING", insider: noInsiders() });
    expect(confidence).toBe(100);
  });
  it("drops with low causal attribution and conflicts", () => {
    const { confidence } = computeConfidence({ entityOk: true, m: market(), filingsOk: true, c: classification({ causal_attribution: "LOW", conflicts: ["x"] }), sourceType: null, insider: noInsiders() });
    expect(confidence).toBeLessThan(50);
  });
});

describe("evThreshold", () => {
  it("computes p* = (L + C) / (W + L)", () => {
    expect(evThreshold(6, 4, 0.3)).toBeCloseTo(0.43, 5);
    expect(evThreshold(0, 0, 1)).toBe(1);
  });
});
