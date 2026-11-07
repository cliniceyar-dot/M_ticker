"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { BullBearAnalysis, ResearchArgument, ResearchEvidence, ResearchSource } from "@/lib/research/types";
import { RESEARCH_DICTS, type ResearchDict } from "@/lib/i18n-research";
import type { Lang } from "@/lib/i18n";
import { toText } from "@/lib/research/export";

const API = "/api/v1/intelligence/bull-bear/analyses";
const LS_LANG = "mticker.lang.v1";

function loadLang(): Lang {
  try { return JSON.parse(localStorage.getItem(LS_LANG) ?? '"en"') === "he" ? "he" : "en"; } catch { return "en"; }
}
const fmtTime = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const d = new Date(iso);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `${d.toLocaleString("en-GB", { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz })} (${tz})`;
};
const fmtDate = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : "—");

type OptKey = "include_sec" | "include_strategy" | "include_news" | "include_youtube" | "include_x" | "include_instagram";
const OPT_KEYS: [OptKey, string][] = [
  ["include_sec", "sec"],
  ["include_strategy", "strategy"],
  ["include_news", "news"],
  ["include_youtube", "youtube"],
  ["include_x", "x"],
  ["include_instagram", "instagram"],
];

export default function ResearchPage() {
  return (
    <Suspense fallback={null}>
      <Research />
    </Suspense>
  );
}

function Research() {
  const [lang, setLang] = useState<Lang>("en");
  const t = RESEARCH_DICTS[lang];
  const [ticker, setTicker] = useState("");
  const [asOf, setAsOf] = useState("");
  const [opts, setOpts] = useState<Record<OptKey, boolean>>({ include_sec: true, include_strategy: true, include_news: true, include_youtube: true, include_x: true, include_instagram: true });
  const [a, setA] = useState<BullBearAnalysis | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hist, setHist] = useState<{ analysis_id: string; created_at: string }[]>([]);
  const [tab, setTab] = useState<"bullish" | "bearish">("bullish");
  const poll = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const l = loadLang();
    setLang(l);
    document.documentElement.lang = l;
    document.documentElement.dir = l === "he" ? "rtl" : "ltr";
    const p = new URLSearchParams(window.location.search);
    const tk = p.get("t");
    const id = p.get("id");
    if (tk) setTicker(tk.toUpperCase());
    if (id) void load(id);
    else if (tk) void loadHistory(tk.toUpperCase());
    return () => { if (poll.current) clearTimeout(poll.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadHistory = useCallback(async (tk: string) => {
    try {
      const r = await fetch(`${API}?ticker=${encodeURIComponent(tk)}`);
      if (r.ok) setHist((await r.json()).analyses ?? []);
    } catch { /* ignore */ }
  }, []);

  const load = useCallback(async (id: string) => {
    if (poll.current) clearTimeout(poll.current);
    try {
      const r = await fetch(`${API}/${encodeURIComponent(id)}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      const an = j as BullBearAnalysis;
      setA(an);
      setTicker(an.ticker);
      window.history.replaceState(null, "", `?t=${an.ticker}&id=${an.analysis_id}`);
      if (an.status === "queued" || an.status === "running") {
        setBusy(true);
        poll.current = setTimeout(() => void load(id), 3000);
      } else {
        setBusy(false);
        void loadHistory(an.ticker);
      }
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadHistory]);

  const start = async () => {
    const tk = ticker.trim().toUpperCase();
    if (!tk) return;
    setErr(null); setBusy(true); setA(null);
    try {
      const r = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker: tk, as_of: asOf ? new Date(asOf).toISOString() : undefined, options: { company_history_months: 36, recent_media_months: 3, ...opts } }),
      });
      const j = await r.json();
      if (r.status !== 202) throw new Error(j.error || `HTTP ${r.status}`);
      void load(j.analysis_id);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="rs-wrap" dir={lang === "he" ? "rtl" : "ltr"}>
      <div className="rs-top no-print">
        <a href={ticker ? `/?t=${ticker}` : "/"}>{t.back}</a>
        <span className="seg lang">
          <button type="button" className={lang === "en" ? "on" : ""} onClick={() => { setLang("en"); localStorage.setItem(LS_LANG, '"en"'); document.documentElement.dir = "ltr"; }}>English</button>
          <button type="button" className={lang === "he" ? "on" : ""} onClick={() => { setLang("he"); localStorage.setItem(LS_LANG, '"he"'); document.documentElement.dir = "rtl"; }}>עברית</button>
        </span>
      </div>
      <h1 className="rs-h1">{t.title}</h1>
      <div className="muted small">{t.subtitle}</div>

      <form className="search no-print" style={{ marginTop: 14 }} onSubmit={(e) => { e.preventDefault(); void start(); }}>
        <label>{t.ticker}<input className="tk" dir="ltr" value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} placeholder="NVDA" /></label>
        <label>{t.asOf}<input type="datetime-local" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></label>
        <button className="btn" disabled={busy || !ticker}>{busy ? <><span className="loader" />{t.running}</> : t.run}</button>
        <div className="rs-opts">
          <span className="muted small">{t.options}:</span>
          {OPT_KEYS.map(([k, ch]) => (
            <label key={k} className="rs-chk"><input type="checkbox" checked={opts[k]} onChange={(e) => setOpts({ ...opts, [k]: e.target.checked })} /> {t.channel[ch]}</label>
          ))}
        </div>
      </form>

      {err && <div className="err" dir="ltr">{err}</div>}
      {busy && !a?.bullish_arguments.length && <div className="empty"><span className="loader" /> {t.pleaseWait}</div>}

      {a && (a.status === "completed" || a.status === "failed") && <Report a={a} t={t} tab={tab} setTab={setTab} textDir={lang === "he" ? "rtl" : "ltr"} />}

      {ticker && (
        <div className="panel no-print" style={{ marginTop: 18 }}>
          <b>{t.history} — {ticker}</b>
          {hist.length === 0 ? <div className="dim small" style={{ marginTop: 6 }}>{t.noHistory}</div> : (
            <ul className="small rs-hist">
              {hist.map((h) => (
                <li key={h.analysis_id}><a href={`?t=${ticker}&id=${h.analysis_id}`} onClick={(e) => { e.preventDefault(); void load(h.analysis_id); }}>{fmtTime(h.created_at)}</a> <span className="dim mono">{h.analysis_id}</span></li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="foot">{t.note}</div>
    </div>
  );
}

function Report({ a, t, tab, setTab, textDir }: { a: BullBearAnalysis; t: ResearchDict; tab: "bullish" | "bearish"; setTab: (x: "bullish" | "bearish") => void; textDir: "ltr" | "rtl" }) {
  const src = new Map(a.sources.map((s) => [s.id, s]));
  const ev = new Map(a.evidence.map((e) => [e.id, e]));
  const histCov = a.coverage.find((c) => c.channel === "sec" || c.channel === "strategy");
  const mediaCov = a.coverage.find((c) => ["news", "youtube", "x", "instagram"].includes(c.channel));

  return (
    <>
      {a.status === "failed" && <div className="err" dir="ltr">{t.status.failed}: {a.error}</div>}
      <div className="panel rs-header">
        <div className="rs-hgrid">
          <div><div className="k">{t.company}</div><div><b dir="ltr">{a.company_name ?? "—"}</b> <span className="mono">({a.ticker})</span></div></div>
          <div><div className="k">{t.analyzed}</div><div className="mono small">{fmtTime(a.completed_at ?? a.created_at)}</div><div className="dim small">as_of {fmtTime(a.as_of)}</div></div>
          <div><div className="k">{t.coverage}</div><div className="small">{t.history3y}: <span className="mono">{histCov ? `${histCov.window.from} → ${histCov.window.to}` : `${a.options.company_history_months} ${t.months}`}</span></div><div className="small">{t.media3m}: <span className="mono">{mediaCov ? `${mediaCov.window.from} → ${mediaCov.window.to}` : `${a.options.recent_media_months} ${t.months}`}</span></div></div>
          <div><div className="k">{t.freshness}</div><div>{t.fresh[a.data_quality.freshness]}</div></div>
          <div><div className="k">{t.completeness}</div><div className={a.data_quality.research_complete ? "pos" : "warn"}>{a.data_quality.research_complete ? t.complete : t.incomplete}</div></div>
          <div><div className="k">{t.lastUpdate}</div><div className="mono small">{fmtTime(a.data_quality.last_successful_update)}</div></div>
        </div>
        <div className="rs-export no-print">
          <button className="btn ghost small" onClick={() => download(`${a.ticker}-bull-bear-${a.analysis_id}.txt`, toText(a), "text/plain")}>{t.exportTxt}</button>
          <button className="btn ghost small" onClick={() => download(`${a.ticker}-bull-bear-${a.analysis_id}.json`, JSON.stringify(a, null, 2), "application/json")}>{t.exportJson}</button>
          <button className="btn ghost small" onClick={() => window.print()}>{t.exportPdf}</button>
        </div>
      </div>

      <div className="rs-tabs no-print">
        <button className={tab === "bullish" ? "on" : ""} onClick={() => setTab("bullish")}>{t.bullTab} ({a.bullish_arguments.length})</button>
        <button className={tab === "bearish" ? "on" : ""} onClick={() => setTab("bearish")}>{t.bearTab} ({a.bearish_arguments.length})</button>
      </div>

      {/* Column order is fixed by spec: bearish LEFT, bullish RIGHT — independent of text direction. */}
      <div className="rs-cols" dir="ltr">
        <section className={`rs-col bear ${tab === "bearish" ? "show" : ""}`} dir={textDir}>
          <h2 className="rs-colh neg">{t.bearish}</h2>
          <Side args={a.bearish_arguments} insufficient={a.insufficient.bearish} t={t} src={src} ev={ev} />
        </section>
        <section className={`rs-col bull ${tab === "bullish" ? "show" : ""}`} dir={textDir}>
          <h2 className="rs-colh pos">{t.bullish}</h2>
          <Side args={a.bullish_arguments} insufficient={a.insufficient.bullish} t={t} src={src} ev={ev} />
        </section>
      </div>

      <div className="grid g2" style={{ marginTop: 16 }}>
        <div className="panel">
          <b>{t.conflicts}</b>
          {a.conflicts.length === 0 ? <div className="dim small" style={{ marginTop: 6 }}>{t.noConflicts}</div> : (
            <ul className="small">{a.conflicts.map((c) => <li key={c.id} dir="ltr">{c.description} <span className="dim">[{c.resolution}] {c.evidence_ids.join(", ")}</span></li>)}</ul>
          )}
          {a.data_quality.missing_sources.length > 0 && (<><b>{t.missing}</b><ul className="small warn" dir="ltr">{a.data_quality.missing_sources.map((m, i) => <li key={i}>{m}</li>)}</ul></>)}
          {a.data_quality.warnings.length > 0 && (<><b>{t.warnings}</b><ul className="small dim" dir="ltr">{a.data_quality.warnings.map((m, i) => <li key={i}>{m}</li>)}</ul></>)}
        </div>
        <div className="panel tablewrap">
          <b>{t.coverageTable}</b>
          <table style={{ marginTop: 6 }}>
            <tbody>
              {a.coverage.map((c) => (
                <tr key={c.channel}>
                  <td>{t.channel[c.channel]}</td>
                  <td className={c.status === "ok" ? "pos" : c.status === "skipped" ? "dim" : "warn"}>{t.covStatus[c.status]}</td>
                  <td className="n">{c.items}</td>
                  <td className="small dim" dir="ltr">{c.note ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="dim small" style={{ marginTop: 8 }} dir="ltr">{a.audit.engine === "claude" ? `Claude · ${a.audit.model}` : "rules"} · {a.audit.prompt_version} · {a.audit.pipeline_version}{a.audit.run_ms ? ` · ${(a.audit.run_ms / 1000).toFixed(0)}s` : ""}</div>
        </div>
      </div>
    </>
  );
}

function Side({ args, insufficient, t, src, ev }: { args: ResearchArgument[]; insufficient: boolean; t: ResearchDict; src: Map<string, ResearchSource>; ev: Map<string, ResearchEvidence> }) {
  if (insufficient || !args.length) return <div className="panel muted rs-insuff">{t.insufficient}</div>;
  return <>{args.map((x) => <ArgCard key={x.id} x={x} t={t} src={src} ev={ev} />)}</>;
}

function ArgCard({ x, t, src, ev }: { x: ResearchArgument; t: ResearchDict; src: Map<string, ResearchSource>; ev: Map<string, ResearchEvidence> }) {
  const sclass = x.evidence_strength === "high" ? "pos" : x.evidence_strength === "medium" ? "acc" : "warn";
  return (
    <article className="panel rs-arg">
      <div className="rs-argh" dir="ltr"><span className="rs-rank">{x.rank}</span><b>{x.title}</b></div>
      <div className="rs-chips">
        <span className={`pill ${sclass}`}>{t.strength}: {t.level[x.evidence_strength]}</span>
        <span className="pill">{t.materiality}: {t.level[x.materiality]}</span>
        <span className="pill">{t.horizon}: {t.horizonL[x.time_horizon]}</span>
        <span className="pill mono">{fmtDate(x.latest_date)}</span>
        <span className="pill">{x.independent_events} {t.events}</span>
      </div>
      <p className="why" dir="ltr">{x.explanation}</p>
      <div className="small muted" dir="ltr">{x.evidence_summary}</div>
      <div className="small rs-srcline" dir="ltr">
        {x.source_ids.slice(0, 3).map((id) => { const s = src.get(id); return s ? <a key={id} href={s.url} target="_blank" rel="noreferrer">{s.provider} · {fmtDate(s.published_at)}</a> : null; })}
        {x.source_ids.length > 3 && <span className="dim">+{x.source_ids.length - 3}</span>}
      </div>
      <details>
        <summary>{t.showEvidence} ({x.evidence_ids.length})</summary>
        <ul className="rs-evlist" dir="ltr">
          {x.evidence_ids.map((id) => {
            const e = ev.get(id);
            if (!e) return null;
            return (
              <li key={id}>
                <div>{e.claim}</div>
                <div className="dim small">{t.ver[e.verification]} · {fmtDate(e.published_at)} · {e.channel}</div>
                <div className="small">{e.source_ids.map((sid) => { const s = src.get(sid); return s ? <a key={sid} href={s.url} target="_blank" rel="noreferrer" style={{ marginInlineEnd: 10 }}>{s.title.slice(0, 90)}</a> : null; })}</div>
              </li>
            );
          })}
          {x.counter_evidence_ids.length > 0 && (
            <li className="warn">{t.counter}: {x.counter_evidence_ids.map((id) => ev.get(id)?.claim.slice(0, 140)).filter(Boolean).join(" | ")}</li>
          )}
        </ul>
      </details>
    </article>
  );
}

function download(name: string, body: string, type: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([body], { type }));
  a.download = name;
  a.click();
}
