import { describe, expect, it } from "vitest";
import { analyzeInsiders } from "@/lib/insider";
import { tx } from "./helpers";

const asOf = new Date("2026-11-06T21:00:00Z");

describe("analyzeInsiders", () => {
  it("scores a recent, large CEO open-market purchase as POSITIVE", () => {
    const a = analyzeInsiders([tx()], asOf, 1);
    expect(a.signal).toBe("POSITIVE");
    const labels = a.score_breakdown.map((b) => b.label);
    expect(labels).toContain("CEO open-market purchase in last 30 days");
    expect(labels).toContain("Single purchase > $250k");
    expect(labels).toContain("Purchase increased ownership > 10%");
    expect(a.score).toBe(12 + 5 + 4);
  });

  it("ignores awards, exercises, tax withholding and gifts", () => {
    const a = analyzeInsiders(["A", "M", "F", "G"].map((code) => tx({ code })), asOf, 4);
    expect(a.score).toBe(0);
    expect(a.signal).toBe("NEUTRAL");
  });

  it("does not count 10b5-1 plan purchases as conviction", () => {
    expect(analyzeInsiders([tx({ plan_10b5_1: true })], asOf, 1).score).toBe(0);
  });

  it("detects a cluster of three or more buyers", () => {
    const a = analyzeInsiders(
      ["A", "B", "C"].map((o) => tx({ owner: o, title: "Director", is_officer: false, is_director: true, value: 20_000, pct_change_ownership: 1 })),
      asOf,
      3,
    );
    expect(a.score_breakdown.map((b) => b.label)).toContain("Cluster of 3 insiders buying");
  });

  it("flags net routine selling as NEGATIVE", () => {
    const a = analyzeInsiders([tx({ code: "S", acquired_disposed: "D" })], asOf, 1);
    expect(a.signal).toBe("NEGATIVE");
    expect(a.score).toBe(-2);
  });

  it("gives older purchases (31–90 days) a smaller weight", () => {
    const a = analyzeInsiders([tx({ trade_date: "2026-08-20", title: "Director", value: 10_000, pct_change_ownership: 1 })], asOf, 1);
    expect(a.score_breakdown).toEqual([{ label: "Purchase 31–90 days ago", points: 3 }]);
  });
});
