import { fetchWithTimeout } from "./http";
import type { Evidence } from "./types";

interface DrugsFdaResult {
  application_number: string;
  sponsor_name: string;
  products?: { brand_name?: string; active_ingredients?: { name: string }[] }[];
  submissions?: {
    submission_type: string;
    submission_number: string;
    submission_status: string;
    submission_status_date: string;
    submission_class_code_description?: string;
  }[];
}

function sponsorKey(company: string): string {
  return company
    .toUpperCase()
    .replace(/[,.]/g, " ")
    .replace(/\b(INC|CORP|CORPORATION|CO|LTD|PLC|LLC|HOLDINGS?|GROUP|N\.?V|S\.?A|AG|THE|\/[A-Z]{2})\b/g, " ")
    .replace(/\/.*$/, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 2)
    .join(" ");
}

/** Official FDA approvals (Drugs@FDA via openFDA) for the sponsor, within the lookback window and before as_of. */
export async function getFdaApprovals(company: string, asOf: Date, lookbackDays = 30): Promise<Evidence[]> {
  const key = sponsorKey(company);
  if (!key || key.length < 3) return [];
  const url = `https://api.fda.gov/drug/drugsfda.json?search=sponsor_name:"${encodeURIComponent(key)}"&limit=50`;
  const res = await fetchWithTimeout(url, { timeoutMs: 9000, cache: "no-store" });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`openFDA ${res.status}`);
  const j = (await res.json()) as { results?: DrugsFdaResult[] };
  const min = asOf.getTime() - lookbackDays * 86400_000;
  const out: Evidence[] = [];
  for (const app of j.results ?? []) {
    for (const s of app.submissions ?? []) {
      if (s.submission_status !== "AP" || !/^\d{8}$/.test(s.submission_status_date)) continue;
      const d = s.submission_status_date;
      // Action dates have day precision only; assume end of the US business day.
      const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T21:00:00.000Z`;
      const t = Date.parse(iso);
      if (t < min || t > asOf.getTime()) continue;
      const brand = app.products?.[0]?.brand_name ?? app.application_number;
      const kind = s.submission_type === "ORIG" ? "Original approval" : `Supplement ${s.submission_number}`;
      out.push({
        id: `fda-${out.length + 1}`,
        source_type: "FDA",
        source_name: "Drugs@FDA (openFDA)",
        source_url: `https://www.accessdata.fda.gov/scripts/cder/daf/index.cfm?event=overview.process&ApplNo=${app.application_number.replace(/\D/g, "")}`,
        headline: `FDA ${kind}: ${brand} (${app.application_number})${s.submission_class_code_description ? ` — ${s.submission_class_code_description}` : ""}`,
        first_public_timestamp: iso,
      });
    }
  }
  return out.sort((a, b) => b.first_public_timestamp.localeCompare(a.first_public_timestamp)).slice(0, 8);
}
