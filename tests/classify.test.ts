import { describe, expect, it } from "vitest";
import { classifyWithRules, noNewsClassification } from "@/lib/classify";
import { evidence, market, noInsiders } from "./helpers";

const asOf = new Date("2026-11-06T15:00:00Z");

describe("classifyWithRules", () => {
  it("detects an earnings beat with raised guidance from the press release", () => {
    const ev = evidence({ excerpt: "The company raised its full-year revenue guidance to $4.2B." });
    const c = classifyWithRules([ev], market(), noInsiders(), asOf, 48);
    expect(c.category).toBe("EARNINGS_GUIDANCE_RAISE");
    expect(c.evidence_ids[0]).toBe("sec-1");
    expect(c.catalyst_strength).toBeGreaterThanOrEqual(20);
  });

  it("infers a positive surprise from the price reaction when guidance is not raised", () => {
    const c = classifyWithRules([evidence()], market({ stock_move_pct: 9, atr_pct: 3 }), noInsiders(), asOf, 48);
    expect(c.category).toBe("EARNINGS_POSITIVE_SURPRISE");
  });

  it("calls results without a strong reaction EARNINGS_MIXED", () => {
    const c = classifyWithRules([evidence()], market({ stock_move_pct: 0.5 }), noInsiders(), asOf, 48);
    expect(c.category).toBe("EARNINGS_MIXED");
  });

  it("classifies tender-offer filings as M&A offers", () => {
    const c = classifyWithRules([evidence({ form: "SC TO-T", items: [], headline: "SC TO-T: tender offer" })], market(), noInsiders(), asOf, 48);
    expect(c.category).toBe("M&A_OFFER");
  });

  it("treats a completed acquisition as a materialization of known news", () => {
    const c = classifyWithRules([evidence({ items: ["2.01"], headline: "8-K: Item 2.01" })], market(), noInsiders(), asOf, 48);
    expect(c.category).toBe("M&A_COMPLETION");
    expect(c.new_or_materialization).toBe("MATERIALIZATION");
  });

  it("classifies FDA approvals from openFDA evidence", () => {
    const c = classifyWithRules([evidence({ id: "fda-1", source_type: "FDA", form: undefined, items: undefined })], market(), noInsiders(), asOf, 48);
    expect(c.category).toBe("FDA_APPROVAL");
  });

  it("ignores evidence outside the freshness window", () => {
    const old = evidence({ first_public_timestamp: "2026-10-01T13:00:00.000Z" });
    expect(classifyWithRules([old], market({ sector_move_pct: 0.2 }), noInsiders(), asOf, 48).category).toBe("NO_IDENTIFIABLE_NEWS");
  });

  it("never treats periodic reports or vote results as catalysts", () => {
    const evs = [
      evidence({ id: "sec-1", form: "10-Q", items: [], headline: "10-Q" }),
      evidence({ id: "sec-2", items: ["5.07"], headline: "8-K: Item 5.07" }),
    ];
    expect(classifyWithRules(evs, market({ sector_move_pct: 0.2 }), noInsiders(), asOf, 48).category).toBe("NO_IDENTIFIABLE_NEWS");
  });
});

describe("noNewsClassification", () => {
  it("returns SECTOR_SYMPATHY when the stock moves with its sector", () => {
    const c = noNewsClassification(market({ sector_move_pct: 7, relative_return_to_sector: 0.5 }), noInsiders());
    expect(c.category).toBe("SECTOR_SYMPATHY");
    expect(c.causal_attribution).toBe("LOW");
  });
  it("returns NO_IDENTIFIABLE_NEWS with possible drivers otherwise", () => {
    const c = noNewsClassification(market({ sector_move_pct: 0.3 }), noInsiders());
    expect(c.category).toBe("NO_IDENTIFIABLE_NEWS");
    expect(c.possible_drivers).toContain("technical breakout");
    expect(c.evidence_ids).toEqual([]);
  });
});
