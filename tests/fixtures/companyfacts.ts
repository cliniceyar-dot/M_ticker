import type { CompanyFacts, XbrlFact } from "@/lib/research/sec-financials";

const yearBefore = (end: string) => new Date(Date.parse(end) - 364 * 86400e3).toISOString().slice(0, 10);
const fyFact = (end: string, val: number, filed: string, accn: string): XbrlFact => ({
  start: yearBefore(end), end, val, accn, fy: Number(end.slice(0, 4)), fp: "FY", form: "10-K", filed,
});
const qFact = (start: string, end: string, val: number, filed: string, accn: string): XbrlFact => ({ start, end, val, accn, fy: null, fp: "Q", form: "10-Q", filed });
const inst = (end: string, val: number, filed: string, accn: string, form = "10-K"): XbrlFact => ({ end, val, accn, fy: null, fp: null, form, filed });

const K23 = "0000000001-23-000010", K24 = "0000000001-24-000010", K25 = "0000000001-25-000010", K26 = "0000000001-26-000010";
const Q25 = "0000000001-25-000020", Q26a = "0000000001-26-000020", Q26b = "0000000001-26-000030";

/** Synthetic company: fast revenue growth, expanding margins, dilution, rising debt. */
export const FACTS: CompanyFacts = {
  cik: 1,
  entityName: "Fictional Demo Corp",
  facts: {
    "us-gaap": {
      Revenues: { units: { USD: [
        fyFact("2023-01-31", 1000e6, "2023-03-10", K23),
        fyFact("2024-01-31", 1200e6, "2024-03-10", K24),
        fyFact("2025-01-31", 1500e6, "2025-03-10", K25),
        fyFact("2026-01-31", 2100e6, "2026-03-10", K26),
        qFact("2025-05-01", "2025-07-31", 450e6, "2025-08-30", Q25),
        qFact("2025-08-01", "2025-10-31", 500e6, "2025-11-30", Q25),
        qFact("2026-05-01", "2026-07-31", 600e6, "2026-08-30", Q26a),
        qFact("2026-08-01", "2026-10-31", 750e6, "2026-11-28", Q26b),
      ] } },
      OperatingIncomeLoss: { units: { USD: [fyFact("2025-01-31", 150e6, "2025-03-10", K25), fyFact("2026-01-31", 315e6, "2026-03-10", K26)] } },
      GrossProfit: { units: { USD: [fyFact("2025-01-31", 900e6, "2025-03-10", K25), fyFact("2026-01-31", 1300e6, "2026-03-10", K26)] } },
      OperatingExpenses: { units: { USD: [fyFact("2025-01-31", 750e6, "2025-03-10", K25), fyFact("2026-01-31", 985e6, "2026-03-10", K26)] } },
      NetIncomeLoss: { units: { USD: [fyFact("2025-01-31", -20e6, "2025-03-10", K25), fyFact("2026-01-31", 240e6, "2026-03-10", K26)] } },
      NetCashProvidedByUsedInOperatingActivities: { units: { USD: [fyFact("2026-01-31", 500e6, "2026-03-10", K26)] } },
      PaymentsToAcquirePropertyPlantAndEquipment: { units: { USD: [fyFact("2026-01-31", 100e6, "2026-03-10", K26)] } },
      WeightedAverageNumberOfDilutedSharesOutstanding: { units: { shares: [fyFact("2025-01-31", 100e6, "2025-03-10", K25), fyFact("2026-01-31", 106e6, "2026-03-10", K26)] } },
      LongTermDebtNoncurrent: { units: { USD: [inst("2025-01-31", 400e6, "2025-03-10", K25), inst("2026-01-31", 800e6, "2026-03-10", K26)] } },
      CashAndCashEquivalentsAtCarryingValue: { units: { USD: [inst("2025-01-31", 900e6, "2025-03-10", K25), inst("2026-01-31", 1000e6, "2026-03-10", K26)] } },
    },
  },
};
