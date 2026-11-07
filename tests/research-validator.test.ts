import { describe, expect, it } from "vitest";
import { compose, detectConflicts, evidenceStrength } from "@/lib/research/validator";
import type { ResearchEvidence } from "@/lib/research/types";
import type { DraftArgument } from "@/lib/research/analysts";

const asOf = new Date("2026-11-07T00:00:00Z");
const ev = (id: string, over: Partial<ResearchEvidence> = {}): ResearchEvidence => ({
  id, source_ids: [`s-${id}`], claim: id, direction: "BULLISH", materiality: "high", verification: "confirmed_fact",
  horizon: "long_term", event_key: `k-${id}`, published_at: "2026-10-01T00:00:00Z", channel: "sec", ...over,
});
const draft = (over: Partial<DraftArgument>): DraftArgument => ({
  title: "Accelerating revenue growth", explanation: "x", evidence_summary: "x", evidence_ids: [], counter_evidence_ids: [], materiality: "high", time_horizon: "medium_term", ...over,
});

describe("evidenceStrength", () => {
  it("rates a corroborated official fact high", () => {
    expect(evidenceStrength([ev("a"), ev("b")], []).level).toBe("high");
  });
  it("does not let repeated coverage of ONE event count as corroboration", () => {
    const reposts = ["n1", "n2", "n3", "n4"].map((id) => ev(id, { channel: "news", verification: "analyst_interpretation", event_key: "news-same-story" }));
    const r = evidenceStrength(reposts, []);
    expect(r.independent).toBe(1);
    expect(r.level).toBe("medium");
  });
  it("caps opinion/speculation at low and downgrades on counter-evidence", () => {
    expect(evidenceStrength([ev("o", { verification: "speculation", channel: "x" })], []).level).toBe("low");
    expect(evidenceStrength([ev("a"), ev("b")], [ev("c")]).level).toBe("medium");
  });
});

describe("compose", () => {
  const evidence = [ev("a"), ev("b"), ev("c", { direction: "BEARISH", event_key: "k-a" }), ev("d", { direction: "BEARISH" })];
  const out = compose({
    asOf,
    evidence,
    sources: evidence.map((e) => ({ id: e.source_ids[0], url: "https://x", title: e.id, provider: "SEC", kind: "sec_filing" as const, channel: "sec" as const, published_at: e.published_at, retrieved_at: asOf.toISOString() })),
    bullish: {
      insufficient: false,
      conflicts: [],
      arguments: [
        draft({ evidence_ids: ["a", "b"] }),
        draft({ title: "Accelerating revenue growth trend", evidence_ids: ["a"] }), // duplicate → merged
        draft({ title: "Invented argument", evidence_ids: ["zzz"] }), // no valid evidence → dropped
      ],
    },
    bearish: { insufficient: true, conflicts: [], arguments: [] },
  });

  it("drops uncited arguments and merges duplicates", () => {
    expect(out.bullish_arguments).toHaveLength(1);
    expect(out.bullish_arguments[0]).toMatchObject({ id: "bull-1", rank: 1, independent_events: 2, evidence_strength: "high" });
    expect(out.warnings.some((w) => w.includes("no verifiable evidence"))).toBe(true);
  });
  it("reports insufficient evidence instead of inventing a side", () => {
    expect(out.bearish_arguments).toEqual([]);
    expect(out.insufficient).toEqual({ bullish: false, bearish: true });
  });
  it("detects the same event reported in opposite directions", () => {
    expect(out.conflicts).toHaveLength(1);
    expect(out.conflicts[0].evidence_ids.sort()).toEqual(["a", "c"]);
    expect(out.conflicts[0].resolution).toBe("official_source_prevails");
  });
  it("only returns sources that evidence actually references", () => {
    expect(out.sources.map((s) => s.id).sort()).toEqual(["s-a", "s-b", "s-c", "s-d"]);
  });
});

describe("detectConflicts", () => {
  it("keeps analyst-reported conflicts that cite at least two evidence items", () => {
    const c = detectConflicts([ev("a"), ev("b")], [{ description: "guidance vs results", evidence_ids: ["a", "b"] }, { description: "bad", evidence_ids: ["a", "nope"] }]);
    expect(c.map((x) => x.description)).toEqual(["guidance vs results"]);
  });
});
