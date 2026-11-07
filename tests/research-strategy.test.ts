import { describe, expect, it } from "vitest";
import { focusOnOutlook, selectReleases } from "@/lib/research/strategy";
import type { Filing } from "@/lib/sec";

const f = (date: string, items: string[]): Filing => ({
  accession: `acc-${date}`, form: "8-K", filingDate: date, acceptedAt: `${date}T21:00:00.000Z`, items,
  primaryDocument: "x.htm", description: "8-K", url: `https://www.sec.gov/${date}`, indexUrl: "",
});

describe("selectReleases", () => {
  const filings = [
    ...["2026-11-01", "2026-08-01", "2026-05-01", "2026-02-01", "2025-11-01", "2025-08-01", "2025-05-01", "2025-02-01", "2024-11-01", "2024-08-01", "2024-05-01", "2024-02-01", "2023-11-01"].map((d) => f(d, ["2.02", "9.01"])),
    f("2026-10-15", ["5.07"]),
  ];
  const picked = selectReleases(filings, 7);
  it("prefers earnings releases and spreads picks across three years", () => {
    expect(picked).toHaveLength(7);
    expect(picked.every((p) => p.items.includes("2.02"))).toBe(true);
    const years = new Set(picked.map((p) => p.filingDate.slice(0, 4)));
    expect(years.has("2023") || years.has("2024")).toBe(true);
    expect(picked[0].filingDate).toBe("2026-11-01");
  });
});

describe("focusOnOutlook", () => {
  it("keeps forward-looking paragraphs within the size limit", () => {
    const text = ["Company reports results for the quarter ended October 2026 with strong performance.", ...Array.from({ length: 30 }, (_, i) => `Filler paragraph number ${i} about unrelated administrative matters and governance.`), "For fiscal 2027 we expect revenue of approximately $3.0 billion and continued margin expansion."].join("\n");
    const out = focusOnOutlook(text, 600);
    expect(out).toContain("we expect revenue");
    expect(out.length).toBeLessThanOrEqual(600);
  });
});
