import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { edgarEtToIso, filingHeadline, listFilings, padCik, parseForm4Xml, type Filing, type Submissions } from "@/lib/sec";

function submissions(): Submissions {
  return {
    cik: "320193",
    name: "Apple Inc.",
    tickers: ["AAPL"],
    exchanges: ["Nasdaq"],
    sic: "3571",
    sicDescription: "Electronic Computers",
    filings: {
      recent: {
        accessionNumber: ["0000320193-26-000010", "0000320193-26-000009", "0000320193-26-000001"],
        filingDate: ["2026-11-06", "2026-11-03", "2026-05-01"],
        acceptanceDateTime: ["2026-11-06T08:03:00.000Z", "2026-11-03T16:30:00.000Z", "2026-05-01T16:30:00.000Z"],
        form: ["8-K", "4", "10-Q"],
        items: ["2.02,9.01", "", ""],
        primaryDocument: ["a8k.htm", "xslF345X05/wk-form4.xml", "q.htm"],
        primaryDocDescription: ["8-K", "FORM 4", "10-Q"],
      },
    },
  };
}

describe("padCik", () => {
  it("zero-pads to 10 digits", () => expect(padCik(320193)).toBe("0000320193"));
});

describe("edgarEtToIso", () => {
  it("treats EDGAR's fake-Z timestamp as US Eastern (EST in November)", () => {
    expect(edgarEtToIso("2026-11-06T08:03:00.000Z")).toBe("2026-11-06T13:03:00.000Z");
  });
  it("applies daylight saving time in summer (EDT)", () => {
    expect(edgarEtToIso("2026-07-01T16:30:00.000Z")).toBe("2026-07-01T20:30:00.000Z");
  });
});

describe("listFilings", () => {
  it("drops filings published after as_of (point-in-time)", () => {
    const asOf = new Date("2026-11-05T00:00:00Z");
    const forms = listFilings(submissions(), asOf, 120).map((f) => f.form);
    expect(forms).toEqual(["4"]);
  });
  it("stops at the lookback window", () => {
    const asOf = new Date("2026-11-07T00:00:00Z");
    const out = listFilings(submissions(), asOf, 30);
    expect(out.map((f) => f.form)).toEqual(["8-K", "4"]);
    expect(out[0].items).toEqual(["2.02", "9.01"]);
    expect(out[0].url).toBe("https://www.sec.gov/Archives/edgar/data/320193/000032019326000010/a8k.htm");
  });
});

describe("filingHeadline", () => {
  it("names 8-K items and hides the exhibits-only item", () => {
    const [f] = listFilings(submissions(), new Date("2026-11-07T00:00:00Z"), 30);
    expect(filingHeadline(f)).toBe("8-K: Item 2.02 Results of Operations and Financial Condition");
  });
});

describe("parseForm4Xml", () => {
  const filing = { acceptedAt: "2026-10-22T20:00:00.000Z", filingDate: "2026-10-22", url: "https://www.sec.gov/f4" } as Filing;
  const txs = parseForm4Xml(readFileSync(new URL("./fixtures/form4.xml", import.meta.url), "utf8"), filing);

  it("parses every non-derivative transaction", () => expect(txs).toHaveLength(2));
  it("reads an open-market purchase with value and ownership change", () => {
    const p = txs[0];
    expect(p).toMatchObject({ owner: "Doe Jane", code: "P", acquired_disposed: "A", shares: 10000, price: 31, value: 310000, owned_after: 60000, plan_10b5_1: false });
    expect(p.title).toContain("Chief Executive Officer");
    expect(p.pct_change_ownership).toBeCloseTo(20, 5);
  });
  it("keeps tax-withholding (F) as a disposal", () => expect(txs[1]).toMatchObject({ code: "F", acquired_disposed: "D" }));
  it("rejects documents that are not Form 4 XML", () => {
    expect(() => parseForm4Xml("<html><body>nope</body></html>", filing)).toThrow(/ownershipDocument/);
  });
});
