import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore, setStoreForTests, getStore } from "@/lib/research/store";
import { MemoryStockStore, setStockStoreForTests } from "@/lib/stocks/store";
import type { BullBearAnalysis, ResearchArgument, ResearchSource } from "@/lib/research/types";

const background: (() => unknown)[] = [];
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => unknown) => background.push(fn) }));

const subs = { filings: { recent: { form: ["10-Q"], filingDate: ["2026-08-01"], acceptanceDateTime: ["2026-08-01T16:05:00.000Z"], accessionNumber: ["x"], primaryDocument: ["x"], reportDate: [""] } } };
const resolveEntity = vi.fn(async (t: string) => {
  if (t === "ZZZZ") throw new Error("Ticker ZZZZ not found");
  return { entity: { ticker: t, cik: "1", name: "Acme" }, submissions: subs };
});
vi.mock("@/lib/sec", async (orig) => ({ ...(await orig<typeof import("@/lib/sec")>()), resolveEntity: (t: string) => resolveEntity(t) }));

let failRuns = false;
const run = vi.fn(async (a: BullBearAnalysis, hooks?: { onProgress?: (c: string, s: string) => unknown }) => {
  await hooks?.onProgress?.("sec", "done");
  const out: BullBearAnalysis = failRuns
    ? { ...a, status: "failed", error: "boom" }
    : { ...fixture(new Date()), analysis_id: a.analysis_id, options: a.options, status: "completed" };
  await getStore().save(out);
  return out;
});
vi.mock("@/lib/research/pipeline", async (orig) => ({ ...(await orig<typeof import("@/lib/research/pipeline")>()), runBullBear: (a: BullBearAnalysis, h: never) => run(a, h) }));

const { toSpecResponse, strengthFrom, parseFilters, capWords } = await import("@/lib/stocks/spec");
const service = await import("@/lib/stocks/service");
const getRoute = await import("@/app/api/v1/stocks/[ticker]/bull-bear/route");
const refreshRoute = await import("@/app/api/v1/stocks/[ticker]/bull-bear/refresh/route");
const jobRoute = await import("@/app/api/v1/jobs/[job_id]/route");
const cronRoute = await import("@/app/api/cron/bull-bear-refresh/route");

const daysAgo = (now: Date, d: number) => new Date(now.getTime() - d * 86400e3).toISOString();
function src(id: string, channel: ResearchSource["channel"], published: string | null): ResearchSource {
  return { id, url: `https://ex.com/${id}`, title: `T ${id}`, provider: "p", kind: "news", channel, published_at: published, retrieved_at: published ?? "" };
}
function arg(id: string, side: "bullish" | "bearish", source_ids: string[], extra: Partial<ResearchArgument> = {}): ResearchArgument {
  return {
    id, side, rank: 1, title: `Argument ${id}`, explanation: "why", evidence_summary: "", evidence_ids: [], source_ids,
    materiality: "high", evidence_strength: "high", time_horizon: "medium_term", latest_date: null, independent_events: 1,
    verification_mix: [], counter_evidence_ids: [], ...extra,
  };
}
function fixture(now: Date): BullBearAnalysis {
  const sources = [src("s1", "sec", daysAgo(now, 10)), src("s2", "news", daysAgo(now, 20)), src("s3", "x", daysAgo(now, 5)), src("s4", "news", daysAgo(now, 400))];
  return {
    analysis_id: "ACME_1", ticker: "ACME", company_name: "Acme", cik: "1", as_of: now.toISOString(), created_at: now.toISOString(), completed_at: now.toISOString(),
    status: "completed",
    options: { company_history_months: 36, recent_media_months: 3, include_sec: true, include_strategy: true, include_news: true, include_youtube: true, include_x: true, include_instagram: true, language: "en" } as never,
    bullish_arguments: [
      arg("b1", "bullish", ["s1", "s2"], { evidence_ids: ["e1"] }),
      arg("b2", "bullish", ["s3"]),
      ...Array.from({ length: 8 }, (_, i) => arg(`bx${i}`, "bullish", ["s4"])),
    ],
    bearish_arguments: [arg("r1", "bearish", ["s2"], { counter_evidence_ids: ["e1"] }), arg("r2", "bearish", ["missing"])],
    insufficient: { bullish: false, bearish: true },
    evidence: [{ id: "e1", source_ids: ["s1"], claim: "Revenue up 20%", direction: "BULLISH", materiality: "high", verification: "confirmed_fact", horizon: "short_term", event_key: "k", published_at: null, channel: "sec" }],
    sources, conflicts: [],
    coverage: [{ channel: "instagram", requested: true, status: "unavailable", window: { from: "", to: "" }, items: 0 }],
    data_quality: { research_complete: true, freshness: "fresh", last_successful_update: null, missing_sources: [], warnings: [] },
    audit: { engine: "rules", model: null, prompt_version: "p", pipeline_version: "p", run_ms: 1 },
    summary: "Balanced.", sources_scanned: 42, history_months: 20,
  } as BullBearAnalysis;
}

describe("spec adapter", () => {
  const now = new Date("2026-11-10T12:00:00Z");
  it("weights sources by type and recency; social-only is capped at weak", () => {
    const s = (type: never, d: number) => ({ source_item_id: "x", type, title: "", url: "", published_at: daysAgo(now, d), excerpt: "" });
    expect(strengthFrom([s("sec_filing" as never, 10), s("news" as never, 10), s("news" as never, 10)], now)).toMatchObject({ score: 7, level: "strong" });
    expect(strengthFrom([s("news" as never, 200), s("news" as never, 200)], now)).toMatchObject({ score: 2.8, level: "weak" });
    expect(strengthFrom(Array.from({ length: 8 }, () => s("x" as never, 1)), now)).toMatchObject({ score: 8, level: "weak", socialOnly: true });
  });

  it("builds the contract: cap of 7, drops sourceless args, flags, notices", () => {
    const r = toSpecResponse(fixture(now), 3, {}, { now });
    expect(r.version).toBe(3);
    expect(r.bull).toHaveLength(7);
    expect(r.bull[0].title).toBe("Argument b1");
    expect(r.bull[0]).toMatchObject({ strength: "medium", strength_score: 5, verified_against_sec: true, source_types: ["official", "news"] });
    expect(r.bull[0].sources[0].excerpt).toBe("Revenue up 20%");
    expect(r.bull.find((a) => a.labels.includes("social_opinion"))?.strength).toBe("weak");
    expect(r.bear).toHaveLength(1);
    expect(r.bear[0].conflict_flag).toBe(true);
    expect(r.notices).toEqual(expect.arrayContaining(["FEW_BEAR_ARGUMENTS", "PARTIAL_HISTORY", "MISSING_SOURCES"]));
    expect(r.notices).not.toContain("FEW_BULL_ARGUMENTS");
    expect(r.missing_sources).toEqual(["instagram"]);
    expect(r.sources_scanned).toBe(42);
    expect(toSpecResponse(fixture(now), 3, {}, { now, stale: true }).notices).toContain("STALE_ANALYSIS");
    expect(r.bull[0].id).toBe(toSpecResponse(fixture(now), 3, {}, { now }).bull[0].id);
  });

  it("filters by source type and date server-side", () => {
    const r = toSpecResponse(fixture(now), 1, { source_types: ["social"] }, { now });
    expect(r.bull.map((a) => a.title)).toEqual(["Argument b2"]);
    const d = toSpecResponse(fixture(now), 1, { from: daysAgo(now, 15).slice(0, 10) }, { now });
    expect(d.bull.every((a) => a.sources.every((s) => s.published_at! >= daysAgo(now, 16)))).toBe(true);
  });

  it("parses filters and caps titles", () => {
    expect(parseFilters(new URLSearchParams("source_types=official,news&from=2026-01-01"))).toEqual({ source_types: ["official", "news"], from: "2026-01-01", to: null });
    expect(parseFilters(new URLSearchParams("source_types=tv"))).toHaveProperty("error");
    expect(parseFilters(new URLSearchParams("from=2026-02-01&to=2026-01-01"))).toHaveProperty("error");
    expect(capWords(Array(20).fill("w").join(" "), 15).split(" ")).toHaveLength(15);
  });
});

const params = (ticker: string) => ({ params: Promise.resolve({ ticker }) });
const get = (ticker: string, q = "") => getRoute.GET(new Request(`http://x/api?${q}`), params(ticker));
const refresh = (ticker: string, id = "c1") => refreshRoute.POST(new Request("http://x/api?lang=en", { method: "POST", headers: { "x-client-id": id } }), params(ticker));
const drain = async () => { while (background.length) await background.shift()!(); };

describe("bull-bear stock API", () => {
  beforeEach(() => {
    setStoreForTests(new MemoryStore());
    setStockStoreForTests(new MemoryStockStore());
    background.length = 0;
    failRuns = false;
    run.mockClear();
  });

  it("202 + job on first request, then 200 from cache with a version", async () => {
    const r1 = await get("acme", "lang=en");
    expect(r1.status).toBe(202);
    const j1 = await r1.json();
    expect(j1.job_id).toMatch(/^job_ACME_/);
    expect((await get("acme", "lang=en")).status).toBe(202); // same running job, no duplicate
    expect(background).toHaveLength(1);
    await drain();
    const job = await (await jobRoute.GET(new Request("http://x"), { params: Promise.resolve({ job_id: j1.job_id }) })).json();
    expect(job).toMatchObject({ status: "done", version: 1 });
    const r2 = await get("acme", "lang=en");
    expect(r2.status).toBe(200);
    expect((await r2.json()).version).toBe(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("validates input: 404 unknown ticker, 400 bad filter", async () => {
    expect((await get("ZZZZ")).status).toBe(404);
    expect((await get("ACME", "source_types=tv")).status).toBe(400);
    expect((await get("ACME", "version=0")).status).toBe(400);
  });

  it("rate-limits manual refresh to once per hour per client and increments versions", async () => {
    await get("ACME", "lang=en");
    await drain();
    const r1 = await refresh("ACME");
    expect(r1.status).toBe(202);
    await drain();
    const r2 = await refresh("ACME");
    expect(r2.status).toBe(429);
    expect(Number(r2.headers.get("Retry-After"))).toBeGreaterThan(3000);
    expect((await refresh("ACME", "other-client")).status).toBe(202);
    const versions = await service.listVersions("ACME", "en");
    expect(versions[0].version).toBe(2);
  });

  it("serves the previous version marked stale when the newest run fails", async () => {
    await get("ACME", "lang=en");
    await drain();
    const store = (await import("@/lib/stocks/store")).getStockStore();
    const idx = (await store.getIndex("ACME", "en"))!;
    idx.versions[0].generated_at = new Date(Date.now() - 25 * 3600e3).toISOString(); // v1 is now outdated
    await store.saveIndex(idx);
    failRuns = true;
    expect((await get("ACME", "lang=en")).status).toBe(202);
    await drain(); // regeneration fails (after one retry)
    expect(run).toHaveBeenCalledTimes(3);
    const r = await get("ACME", "lang=en");
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.version).toBe(1);
    expect(body.notices).toContain("STALE_ANALYSIS");
  });

  it("protects the cron endpoint", async () => {
    const prev = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "s3cret";
    expect((await cronRoute.GET(new Request("http://x"))).status).toBe(401);
    expect((await cronRoute.GET(new Request("http://x", { headers: { authorization: "Bearer s3cret" } }))).status).toBe(200);
    process.env.CRON_SECRET = prev;
  });
});
