import type { BullBearAnalysis, ResearchArgument } from "./types";

const fmtDate = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : "—");

/** Plain-text export of a Bullish vs. Bearish report (bearish first, matching the left-to-right layout). */
export function toText(a: BullBearAnalysis): string {
  const src = new Map(a.sources.map((s) => [s.id, s]));
  const side = (title: string, args: ResearchArgument[], insufficient: boolean) => {
    const lines = [`== ${title} ==`];
    if (insufficient || !args.length) lines.push("Insufficient verified evidence.");
    for (const x of args) {
      lines.push(`\n${x.rank}. ${x.title}  [evidence: ${x.evidence_strength}; materiality: ${x.materiality}; ${x.time_horizon}; latest ${fmtDate(x.latest_date)}]`);
      lines.push(x.explanation);
      lines.push(`Evidence: ${x.evidence_summary}`);
      for (const id of x.source_ids) { const s = src.get(id); if (s) lines.push(`  - ${s.title} (${fmtDate(s.published_at)}) ${s.url}`); }
    }
    return lines.join("\n");
  };
  return [
    `${a.company_name ?? a.ticker} (${a.ticker}) — Bullish vs. Bearish Case`,
    `Analysis: ${a.completed_at ?? a.created_at}  |  as_of: ${a.as_of}  |  complete: ${a.data_quality.research_complete}  |  freshness: ${a.data_quality.freshness}`,
    "",
    side("BEARISH CASE — Arguments Against Further Upside", a.bearish_arguments, a.insufficient.bearish),
    "",
    side("BULLISH CASE — Supporting Further Upside", a.bullish_arguments, a.insufficient.bullish),
    "",
    a.conflicts.length ? `Conflicts:\n${a.conflicts.map((c) => `  - ${c.description}`).join("\n")}` : "Conflicts: none detected",
    a.data_quality.missing_sources.length ? `Missing sources:\n${a.data_quality.missing_sources.map((m) => `  - ${m}`).join("\n")}` : "",
    "",
    "Decision support only. No probability of price appreciation is implied.",
  ].join("\n");
}
