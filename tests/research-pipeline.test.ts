import { beforeEach, describe, expect, it, vi } from "vitest";
import { FACTS } from "./fixtures/companyfacts";
import { MemoryStore, setStoreForTests, getStore } from "@/lib/research/store";
import { DEFAULT_OPTIONS } from "@/lib/research/types";

vi.mock("@/lib/sec", async (orig) => ({
  ...(await orig<typeof import("@/lib/sec")>()),
  resolveEntity: async () => ({
    entity: { ticker: "DEMO", company_name: "Fictional Demo Corp", cik: "0000000001", exchange: "Nasdaq", sic: "7372", sector: "Technology", industry: "Software", sector_etf: "XLK" },
    submissions: { cik: "1", name: "Fictional Demo Corp", tickers: ["DEMO"], exchanges: ["Nasdaq"], sic: "7372", sicDescription: "Software", filings: { recent: { accessionNumber: [], filingDate: [], acceptanceDateTime: [], form: [], items: [], primaryDocument: [], primaryDocDescription: [] } } },
  }),
}));
vi.mock("@/lib/research/sec-financials", async (orig) => ({ ...(await orig<typeof import("@/lib/research/sec-financials")>()), fetchCompanyFacts: async () => FACTS }));

const { newAnalysis, runBullBear } = await import("@/lib/research/pipeline");

describe("runBullBear without the Claude layer (rules mode)", () => {
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    setStoreForTests(new MemoryStore());
  });

  it("produces SEC-grounded arguments on both sides and reports missing channels", async () => {
    const a = await runBullBear(newAnalysis("DEMO_20261107T160000Z_abcdef", "DEMO", new Date("2026-11-07T16:00:00Z"), DEFAULT_OPTIONS));
    expect(a.status).toBe("completed");
    expect(a.company_name).toBe("Fictional Demo Corp");
    expect(a.bullish_arguments.length).toBeGreaterThan(0);
    expect(a.bearish_arguments.map((x) => x.title)).toEqual(expect.arrayContaining(["Shareholder dilution", "Rising leverage"]));
    for (const arg of [...a.bullish_arguments, ...a.bearish_arguments]) {
      expect(arg.source_ids.length).toBeGreaterThan(0);
      expect(arg.evidence_ids.every((id) => a.evidence.some((e) => e.id === id))).toBe(true);
    }
    const cov = Object.fromEntries(a.coverage.map((c) => [c.channel, c.status]));
    expect(cov).toMatchObject({ sec: "ok", news: "unavailable", youtube: "unavailable", x: "unavailable", instagram: "unavailable" });
    expect(a.data_quality.research_complete).toBe(false);
    expect(a.data_quality.missing_sources.length).toBeGreaterThan(0);
    expect(a.audit).toMatchObject({ engine: "rules", prompt_version: expect.any(String) });
    expect(JSON.stringify(a)).not.toMatch(/probabilit(y|ies)"\s*:/);
    expect((await getStore().get(a.analysis_id))?.status).toBe("completed");
  });

  it("marks the analysis failed (and saves it) when the company cannot be resolved", async () => {
    const sec = await import("@/lib/sec");
    vi.spyOn(sec, "resolveEntity").mockRejectedValueOnce(new Error("Ticker ZZZZ not found"));
    const a = await runBullBear(newAnalysis("ZZZZ_20261107T160000Z_abcdef", "ZZZZ", new Date(), DEFAULT_OPTIONS));
    expect(a.status).toBe("failed");
    expect(a.error).toContain("not found");
  });
});
