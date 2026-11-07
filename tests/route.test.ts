import { beforeEach, describe, expect, it, vi } from "vitest";

const analyze = vi.fn();
vi.mock("@/lib/pipeline", () => ({ analyze: (...a: unknown[]) => analyze(...a) }));

const { GET, POST } = await import("@/app/api/analyze/route");

describe("/api/analyze", () => {
  beforeEach(() => {
    analyze.mockReset();
    analyze.mockResolvedValue({ ticker: "ABCD" });
  });

  it("rejects a missing ticker with 400", async () => {
    const res = await GET(new Request("http://x/api/analyze"));
    expect(res.status).toBe(400);
    expect(analyze).not.toHaveBeenCalled();
  });

  it("passes breakout context from the query string", async () => {
    const res = await GET(new Request("http://x/api/analyze?ticker=abcd&pattern=peak&breakout_date=2026-11-06&breakout_high=35.5&threshold=0.7"));
    expect(res.status).toBe(200);
    expect(analyze).toHaveBeenCalledWith({
      ticker: "abcd",
      asOf: null,
      threshold: 0.7,
      breakout: { confirmed_by_user: true, pattern: "PEAK", breakout_date: "2026-11-06", breakout_high: 35.5 },
    });
  });

  it("ignores invalid breakout patterns and thresholds", async () => {
    await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ ticker: "ABCD", breakout: { pattern: "SIDEWAYS" }, threshold: 3 }) }));
    expect(analyze).toHaveBeenCalledWith({ ticker: "ABCD", asOf: null, breakout: null, threshold: undefined });
  });

  it("returns 400 for invalid JSON", async () => {
    const res = await POST(new Request("http://x", { method: "POST", body: "{not json" }));
    expect(res.status).toBe(400);
  });

  it("maps unknown tickers to 404 and upstream failures to 502", async () => {
    analyze.mockRejectedValueOnce(new Error("Ticker ZZZZ not found in SEC EDGAR"));
    expect((await GET(new Request("http://x/api/analyze?ticker=ZZZZ"))).status).toBe(404);
    analyze.mockRejectedValueOnce(new Error("SEC 503"));
    expect((await GET(new Request("http://x/api/analyze?ticker=ABCD"))).status).toBe(502);
  });
});
