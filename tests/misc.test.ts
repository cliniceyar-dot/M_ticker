import { describe, expect, it } from "vitest";
import { sectorFromSic } from "@/lib/sectors";
import { htmlToText, mapLimit } from "@/lib/http";
import { BASE_STRENGTH, CATEGORY_LABEL } from "@/lib/taxonomy";
import { CATALYST_CATEGORIES } from "@/lib/types";
import { DICTS } from "@/lib/i18n";

describe("sectorFromSic", () => {
  it.each([
    ["2836", "XBI"],
    ["3674", "SMH"],
    ["3571", "XLK"],
    ["6022", "XLF"],
    ["1311", "XLE"],
    ["", "SPY"],
  ])("SIC %s → %s", (sic, etf) => expect(sectorFromSic(sic).etf).toBe(etf));
});

describe("htmlToText", () => {
  it("strips tags, scripts and entities", () => {
    const t = htmlToText("<p>Revenue&nbsp;up&amp;away</p><script>x()</script><div>Line&#8217;s 2</div>");
    expect(t).toBe("Revenue up&away\nLine's 2");
  });
});

describe("mapLimit", () => {
  it("preserves order and respects the concurrency limit", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 3, 2], 2, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, n));
      active--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 30, 20]);
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe("taxonomy", () => {
  it("has a base strength range and label for every category", () => {
    for (const c of CATALYST_CATEGORIES) {
      const [lo, hi] = BASE_STRENGTH[c];
      expect(lo).toBeLessThanOrEqual(hi);
      expect(hi).toBeLessThanOrEqual(25);
      expect(CATEGORY_LABEL[c]).toBeTruthy();
    }
  });
});

describe("i18n", () => {
  it("Hebrew has every key English has", () => {
    expect(Object.keys(DICTS.he).sort()).toEqual(Object.keys(DICTS.en).sort());
    expect(Object.keys(DICTS.he.fbLabels).sort()).toEqual(Object.keys(DICTS.en.fbLabels).sort());
  });
});
