import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore, setStoreForTests } from "@/lib/research/store";

const background: (() => unknown)[] = [];
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => unknown) => background.push(fn) }));
const run = vi.fn();
vi.mock("@/lib/research/pipeline", async (orig) => ({ ...(await orig<typeof import("@/lib/research/pipeline")>()), runBullBear: (a: unknown) => run(a) }));

const list = await import("@/app/api/v1/intelligence/bull-bear/analyses/route");
const one = await import("@/app/api/v1/intelligence/bull-bear/analyses/[id]/route");
const post = (body: unknown) => list.POST(new Request("http://x", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }));

describe("bull-bear API", () => {
  beforeEach(() => {
    setStoreForTests(new MemoryStore());
    background.length = 0;
    run.mockReset();
  });

  it("accepts a ticker with 202, stores the analysis and schedules work in the background", async () => {
    const res = await post({ ticker: "nvda", as_of: "2026-11-07T16:00:00Z", options: { include_x: false, company_history_months: 999 } });
    expect(res.status).toBe(202);
    const j = await res.json();
    expect(j.status).toBe("queued");
    expect(j.analysis_id).toMatch(/^NVDA_/);
    expect(background).toHaveLength(1);
    background[0]();
    const a = run.mock.calls[0][0];
    expect(a.options).toMatchObject({ include_x: false, include_sec: true, company_history_months: 60 });
    expect(a.as_of).toBe("2026-11-07T16:00:00.000Z");

    const got = await one.GET(new Request("http://x"), { params: Promise.resolve({ id: j.analysis_id }) });
    expect(got.status).toBe(200);
    expect((await got.json()).ticker).toBe("NVDA");
  });

  it("clamps future as_of to now (no look-ahead)", async () => {
    const j = await (await post({ ticker: "AAPL", as_of: "2099-01-01T00:00:00Z" })).json();
    expect(Date.parse(j.as_of)).toBeLessThanOrEqual(Date.now());
  });

  it("validates input", async () => {
    expect((await post({ ticker: "" })).status).toBe(400);
    expect((await post({ ticker: "NVDA", as_of: "nope" })).status).toBe(400);
    expect((await post("{bad")).status).toBe(400);
    expect((await one.GET(new Request("http://x"), { params: Promise.resolve({ id: "../../x" }) })).status).toBe(400);
    expect((await one.GET(new Request("http://x"), { params: Promise.resolve({ id: "NVDA_20261107T160000Z_abcdef" }) })).status).toBe(404);
  });

  it("lists history per ticker", async () => {
    await post({ ticker: "MSFT" });
    const res = await list.GET(new Request("http://x?ticker=msft"));
    expect((await res.json()).analyses).toHaveLength(1);
  });
});
