import { describe, expect, it } from "vitest";
import { MemoryStore, newAnalysisId, tickerFromId } from "@/lib/research/store";
import { newAnalysis } from "@/lib/research/pipeline";
import { DEFAULT_OPTIONS } from "@/lib/research/types";

describe("analysis ids", () => {
  it("round-trips the ticker", () => {
    const id = newAnalysisId("brk.b", new Date("2026-11-07T16:00:00Z"));
    expect(id).toMatch(/^BRK\.B_20261107T160000Z_[a-z0-9]{6}$/);
    expect(tickerFromId(id)).toBe("BRK.B");
    expect(tickerFromId("../etc/passwd")).toBeNull();
  });
});

describe("MemoryStore", () => {
  it("saves, retrieves copies and lists history newest-first", async () => {
    const s = new MemoryStore();
    const a1 = { ...newAnalysis(newAnalysisId("NVDA"), "NVDA", new Date(), DEFAULT_OPTIONS), created_at: "2026-11-01T00:00:00Z" };
    const a2 = { ...newAnalysis(newAnalysisId("NVDA"), "NVDA", new Date(), DEFAULT_OPTIONS), created_at: "2026-11-05T00:00:00Z" };
    await s.save(a1);
    await s.save(a2);
    await s.save(newAnalysis(newAnalysisId("AAPL"), "AAPL", new Date(), DEFAULT_OPTIONS));
    const got = await s.get(a1.analysis_id);
    got!.status = "failed";
    expect((await s.get(a1.analysis_id))!.status).toBe("queued");
    expect((await s.listByTicker("nvda")).map((h) => h.analysis_id)).toEqual([a2.analysis_id, a1.analysis_id]);
  });
});
