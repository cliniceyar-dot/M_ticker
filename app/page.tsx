"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { BreakoutPattern, Report } from "@/lib/types";
import { CATEGORY_LABEL } from "@/lib/taxonomy";
import { DICTS, type Dict, type Lang } from "@/lib/i18n";

type Tab = "evidence" | "insiders" | "market" | "score" | "history" | "audit";
interface WatchItem { ticker: string; p: number | null; conf: number | null; at: string; alerted?: boolean }
interface Feedback { ticker: string; as_of: string; category: string; p: number | null; label: string; at: string }

const LS_WATCH = "mticker.watchlist.v1";
const LS_FB = "mticker.feedback.v1";
const LS_ALERT = "mticker.alertThreshold.v1";
const LS_LANG = "mticker.lang.v1";

function load<T>(k: string, d: T): T {
  try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : d; } catch { return d; }
}
function save(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } }

const f = (x: number | null | undefined, d = 2, suf = "") => (x === null || x === undefined || Number.isNaN(x) ? "—" : `${x.toFixed(d)}${suf}`);
const sgn = (x: number | null | undefined, d = 1) => (x === null || x === undefined ? "—" : `${x >= 0 ? "+" : ""}${x.toFixed(d)}%`);
const cls = (x: number | null | undefined) => (x === null || x === undefined ? "" : x >= 0 ? "pos" : "neg");
const et = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) + " ET" : "—";
const money = (x: number | null) => (x === null ? "—" : x >= 1e6 ? `$${(x / 1e6).toFixed(2)}M` : x >= 1e3 ? `$${(x / 1e3).toFixed(0)}k` : `$${x.toFixed(0)}`);

async function fetchReport(body: unknown): Promise<Report> {
  const res = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
  return j as Report;
}

export default function Home() {
  const [lang, setLang] = useState<Lang>("en");
  const t = DICTS[lang];
  const [ticker, setTicker] = useState("");
  const [mode, setMode] = useState<"scan" | "breakout">("scan");
  const [pattern, setPattern] = useState<BreakoutPattern>("PEAK");
  const [bDate, setBDate] = useState("");
  const [bHigh, setBHigh] = useState("");
  const [asOf, setAsOf] = useState("");
  const [threshold, setThreshold] = useState(0.6);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [r, setR] = useState<Report | null>(null);
  const [tab, setTab] = useState<Tab>("evidence");
  const [watch, setWatch] = useState<WatchItem[]>([]);
  const [feedback, setFeedback] = useState<Feedback[]>([]);
  const [alertThr, setAlertThr] = useState(0.65);
  const [alerts, setAlerts] = useState<string[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const changeLang = (l: Lang) => { setLang(l); save(LS_LANG, l); };
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "he" ? "rtl" : "ltr";
  }, [lang]);

  const run = useCallback(
    async (tk?: string) => {
      const tt = (tk ?? ticker).trim().toUpperCase();
      if (!tt) return;
      setLoading(true); setErr(null);
      try {
        const body: Record<string, unknown> = { ticker: tt, threshold };
        if (asOf) body.as_of = new Date(asOf).toISOString();
        if (mode === "breakout") body.breakout = { confirmed_by_user: true, pattern, breakout_date: bDate, breakout_high: Number(bHigh) || 0 };
        const rep = await fetchReport(body);
        setR(rep);
        setTab("evidence");
        history.replaceState(null, "", `?t=${tt}`);
        setWatch((w) => {
          const nw = w.map((x) => (x.ticker === tt ? { ...x, p: rep.probability_no_averaging, conf: rep.confidence, at: rep.as_of } : x));
          save(LS_WATCH, nw);
          return nw;
        });
      } catch (e) {
        setErr((e as Error).message); setR(null);
      } finally { setLoading(false); }
    },
    [ticker, threshold, asOf, mode, pattern, bDate, bHigh],
  );

  useEffect(() => {
    setWatch(load<WatchItem[]>(LS_WATCH, []));
    setFeedback(load<Feedback[]>(LS_FB, []));
    setAlertThr(load<number>(LS_ALERT, 0.65));
    setLang(load<Lang>(LS_LANG, "en") === "he" ? "he" : "en");
    const q = new URLSearchParams(window.location.search).get("t");
    if (q) { setTicker(q.toUpperCase()); void run(q.toUpperCase()); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const inWatch = r ? watch.some((w) => w.ticker === r.ticker) : false;
  const toggleWatch = () => {
    if (!r) return;
    const nw = inWatch ? watch.filter((w) => w.ticker !== r.ticker) : [...watch, { ticker: r.ticker, p: r.probability_no_averaging, conf: r.confidence, at: r.as_of }];
    setWatch(nw); save(LS_WATCH, nw);
  };
  const removeWatch = (tk: string) => { const nw = watch.filter((w) => w.ticker !== tk); setWatch(nw); save(LS_WATCH, nw); };

  const refreshWatch = async () => {
    setRefreshing(true);
    const fired: string[] = [];
    const next: WatchItem[] = [];
    for (const w of watch) {
      try {
        const rep = await fetchReport({ ticker: w.ticker });
        const p = rep.probability_no_averaging;
        const crossed = p !== null && p >= alertThr && (w.p === null || w.p < alertThr);
        if (crossed) fired.push(t.alertCrossed(w.ticker, Math.round(alertThr * 100), Math.round(p * 100), CATEGORY_LABEL[rep.primary_catalyst.category]));
        next.push({ ticker: w.ticker, p, conf: rep.confidence, at: rep.as_of, alerted: crossed });
      } catch { next.push(w); }
    }
    setWatch(next); save(LS_WATCH, next);
    setAlerts((a) => [...fired, ...a].slice(0, 20));
    setRefreshing(false);
  };

  const giveFeedback = (label: string) => {
    if (!r) return;
    const nf = [{ ticker: r.ticker, as_of: r.as_of, category: r.primary_catalyst.category, p: r.probability_no_averaging, label, at: new Date().toISOString() }, ...feedback].slice(0, 500);
    setFeedback(nf); save(LS_FB, nf);
  };

  return (
    <div className="shell" dir={lang === "he" ? "rtl" : "ltr"}>
      <aside className="side">
        <div className="brand"><span className="brand-dot" /> M-Ticker</div>
        <div className="brand-sub">{t.brandSub}</div>

        <div className="seg lang" role="group" aria-label={t.language}>
          <button type="button" className={lang === "en" ? "on" : ""} onClick={() => changeLang("en")}>English</button>
          <button type="button" className={lang === "he" ? "on" : ""} onClick={() => changeLang("he")}>עברית</button>
        </div>

        <h4>{t.watchlist}</h4>
        {watch.length === 0 && <div className="dim small">{t.watchEmpty}</div>}
        {watch.map((w) => (
          <div key={w.ticker} className={`wl-item ${r?.ticker === w.ticker ? "active" : ""}`} onClick={() => { setTicker(w.ticker); void run(w.ticker); }}>
            <span className="wl-t">{w.ticker}{w.alerted ? " 🔔" : ""}</span>
            <span className="wl-p">{w.p === null ? "—" : `${Math.round(w.p * 100)}%`} · {w.conf ?? "—"}</span>
            <button className="x" title={t.remove} onClick={(e) => { e.stopPropagation(); removeWatch(w.ticker); }}>×</button>
          </div>
        ))}
        {watch.length > 0 && (
          <button className="btn ghost small" style={{ marginTop: 8, width: "100%" }} disabled={refreshing} onClick={refreshWatch}>
            {refreshing ? <><span className="loader" />{t.refreshing}</> : t.refresh}
          </button>
        )}

        <h4>{t.alerts}</h4>
        <label className="small muted" style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {t.alertWhen}
          <input type="number" min={0.05} max={0.95} step={0.05} value={alertThr} style={{ width: 70, padding: "4px 6px" }}
            onChange={(e) => { const v = Number(e.target.value); setAlertThr(v); save(LS_ALERT, v); }} />
        </label>
        {alerts.length === 0 ? <div className="dim small" style={{ marginTop: 6 }}>{t.noAlerts}</div> :
          alerts.map((a, i) => <div key={i} className="small warn" style={{ marginTop: 6 }}>{a}</div>)}

        <h4>{t.modelAudit} ({feedback.length})</h4>
        {feedback.slice(0, 6).map((fb, i) => (
          <div key={i} className="small" style={{ marginBottom: 4 }}>
            <span className="mono">{fb.ticker}</span> <span className="dim mono">{fb.p === null ? "—" : `${Math.round(fb.p * 100)}%`}</span> → <span className="muted">{t.fbLabels[fb.label] ?? fb.label}</span>
          </div>
        ))}
        {feedback.length > 0 && (
          <button className="btn ghost small" style={{ marginTop: 6, width: "100%" }} onClick={() => {
            const blob = new Blob([JSON.stringify(feedback, null, 2)], { type: "application/json" });
            const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "mticker-feedback.json"; a.click();
          }}>{t.exportLabels}</button>
        )}
      </aside>

      <main className="main">
        <form className="search" onSubmit={(e) => { e.preventDefault(); void run(); }}>
          <label>{t.ticker}<input className="tk" dir="ltr" value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} placeholder="ABCD" autoFocus /></label>
          <label>{t.mode}
            <span className="seg">
              <button type="button" className={mode === "scan" ? "on" : ""} onClick={() => setMode("scan")}>{t.liveScan}</button>
              <button type="button" className={mode === "breakout" ? "on" : ""} onClick={() => setMode("breakout")}>{t.breakoutDecision}</button>
            </span>
          </label>
          {mode === "breakout" && (
            <>
              <label>{t.pattern}
                <select value={pattern} onChange={(e) => setPattern(e.target.value as BreakoutPattern)}>
                  <option value="PEAK">PEAK</option><option value="CENTER">CENTER</option><option value="BOTTOM">BOTTOM</option>
                </select>
              </label>
              <label>{t.breakoutDate}<input type="date" value={bDate} onChange={(e) => setBDate(e.target.value)} /></label>
              <label>{t.d0High}<input type="number" step="0.01" value={bHigh} onChange={(e) => setBHigh(e.target.value)} style={{ width: 100 }} /></label>
              <label>{t.entryThreshold}<input type="number" min={0.05} max={0.95} step={0.01} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} style={{ width: 80 }} /></label>
            </>
          )}
          <label>{t.asOf}<input type="datetime-local" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></label>
          <button className="btn" disabled={loading || !ticker}>{loading ? <><span className="loader" />{t.analyzing}</> : t.analyze}</button>
        </form>

        {err && <div className="err" dir="ltr">{err}</div>}
        {!r && !err && !loading && <div className="empty"><h2>{t.emptyTitle}</h2><div>{t.emptyBody}</div></div>}
        {loading && !r && <div className="empty"><span className="loader" /> {t.loadingMsg}</div>}

        {r && <ReportView t={t} r={r} tab={tab} setTab={setTab} inWatch={inWatch} toggleWatch={toggleWatch} giveFeedback={giveFeedback} threshold={threshold} />}

        <div className="foot">{t.foot}</div>
      </main>
    </div>
  );
}

function stateClass(r: Report) {
  if (r.status === "CONFLICTING_INFORMATION") return "stop";
  if (r.action === "ENTRY_CANDIDATE") return "go";
  return "wait";
}

function ReportView({ t, r, tab, setTab, inWatch, toggleWatch, giveFeedback, threshold }: {
  t: Dict; r: Report; tab: Tab; setTab: (x: Tab) => void; inWatch: boolean; toggleWatch: () => void; giveFeedback: (l: string) => void; threshold: number;
}) {
  const m = r.market_context;
  const pc = r.primary_catalyst;
  const p = r.probability_no_averaging;
  const pColor = p === null ? "var(--warn)" : p >= threshold ? "var(--pos)" : p >= 0.45 ? "var(--warn)" : "var(--neg)";
  const freshCls = r.freshness === "HIGH" ? "pos" : r.freshness === "MEDIUM" ? "acc" : r.freshness === "LOW" ? "warn" : "neg";
  const lvl = (x: string) => t.levels[x] ?? x;
  const confLevel = r.confidence >= 75 ? "HIGH" : r.confidence >= 50 ? "MEDIUM" : "LOW";
  const tabLabel: Record<Tab, string> = {
    evidence: `${t.tabEvidence} (${r.evidence.length})`,
    insiders: `${t.tabInsiders} (${r.insider.transactions.length})`,
    market: t.tabMarket,
    score: t.tabScore,
    history: `${t.tabFilings} (${r.filings.length})`,
    audit: t.tabAudit,
  };

  return (
    <>
      <div className="head">
        <span className="t mono">{r.ticker}</span>
        <span className="px mono">{m.last_price !== null ? `$${m.last_price.toFixed(2)}` : "—"}</span>
        <span className={`px mono ${cls(m.stock_move_pct)}`}>{sgn(m.stock_move_pct)}</span>
        <span className="co" dir="ltr">{r.entity.company_name} · {r.entity.exchange ?? "—"} · {r.entity.sector ?? r.entity.industry ?? "—"}</span>
        <span style={{ flex: 1 }} />
        <a className="btn ghost small" href={`/research?t=${r.ticker}`}>{t.bullBear}</a>
        <button className="btn ghost small" onClick={toggleWatch}>{inWatch ? t.inWatch : t.addWatch}</button>
      </div>

      <div className="event">
        <span className={`pill ${r.significant_event_now ? "pos" : ""}`}>{r.significant_event_now ? t.eventDetected : t.noEvent}</span>
        <span className="pill acc mono">{pc.category}</span>
        <span className={`pill ${freshCls}`}>{t.freshness}: {lvl(r.freshness)}</span>
        {r.historical_replay && <span className="pill warn">{t.replay} {et(r.as_of)}</span>}
        <span className="pill">{pc.engine === "claude" ? `Claude · ${pc.model ?? ""}` : t.rulesEngine}</span>
      </div>

      <div className="grid g4">
        <div className="panel tile">
          <div className="k">{t.pNoAvg}</div>
          <div className="v" style={{ color: pColor }}>{p === null ? t.suppressed : `${Math.round(p * 100)}%`}</div>
          <div className="bar"><i style={{ width: `${(p ?? 0) * 100}%`, background: pColor }} /></div>
          <div className="s">{t.seedModel}</div>
        </div>
        <div className="panel tile">
          <div className="k">{t.confidence}</div>
          <div className="v">{r.confidence}<span className="dim" style={{ fontSize: 16 }}>/100</span></div>
          <div className="bar"><i style={{ width: `${r.confidence}%`, background: "var(--accent)" }} /></div>
          <div className="s">{lvl(confLevel)} — {t.confSub}</div>
        </div>
        <div className="panel tile">
          <div className="k">{t.rawScore}</div>
          <div className="v">{r.raw_score.toFixed(0)}<span className="dim" style={{ fontSize: 16 }}>/100</span></div>
          <div className="bar"><i style={{ width: `${r.raw_score}%`, background: "var(--muted)" }} /></div>
          <div className="s">{t.rawSub}</div>
        </div>
        <div className="panel tile">
          <div className="k">{t.breakoutCtx}</div>
          <div className="v" style={{ fontSize: 24 }}>{r.breakout ? r.breakout.pattern : "—"}</div>
          <div className="s">{r.breakout ? `${r.breakout.breakout_date || t.dateNA} · ${t.d0High} ${r.breakout.breakout_high || "—"}` : t.liveNoBreakout}</div>
        </div>
      </div>

      <div className={`state ${stateClass(r)}`}>
        <span dir="ltr">{r.system_state ?? r.action}</span>
        {r.status === "CONFLICTING_INFORMATION" && t.conflictSuffix}
      </div>

      <div className="grid g2" style={{ marginTop: 14 }}>
        <div className="panel">
          <div className="kv">
            <span className="k">{t.primaryCatalyst}</span><span dir="ltr"><b>{pc.headline}</b></span>
            <span className="k">{t.firstPublic}</span><span className="mono">{et(pc.event_time)}{r.hours_since_event !== null && <span className="dim"> ({r.hours_since_event.toFixed(1)}{t.hAgo})</span>}</span>
            <span className="k">{t.classification}</span><span className="mono">{pc.category}</span>
            <span className="k">{t.newVsKnown}</span><span className="mono">{pc.new_or_materialization}</span>
            <span className="k">{t.primarySource}</span><span>{pc.source_url ? <a href={pc.source_url} target="_blank" rel="noreferrer">{pc.source_type}</a> : "—"}</span>
            <span className="k">{t.causal}</span><span className={pc.causal_attribution === "LOW" ? "warn" : ""}>{lvl(pc.causal_attribution)}</span>
            {pc.secondary_catalysts.length > 0 && (<><span className="k">{t.secondary}</span><span className="mono small">{pc.secondary_catalysts.join(", ")}</span></>)}
          </div>
        </div>
        <div className="panel">
          <div className="muted small" style={{ textTransform: "uppercase", letterSpacing: ".06em" }}>{t.why}</div>
          <p className="why" dir="ltr">{pc.reasoning_summary}</p>
          {pc.possible_drivers.length > 0 && <p className="small muted">{t.possibleDrivers}: <span dir="ltr">{pc.possible_drivers.join(" · ")}</span></p>}
          <div className="small"><span className="warn">{t.mainRisk}:</span> <span dir="ltr">{pc.main_risk}</span></div>
          {pc.conflicts.length > 0 && <div className="small neg" style={{ marginTop: 6 }}>{t.conflicts}: <span dir="ltr">{pc.conflicts.join("; ")}</span></div>}
          <div className="small" style={{ marginTop: 8 }}>
            <span className="muted">{t.insiders}:</span> <b className={r.insider.signal === "POSITIVE" ? "pos" : r.insider.signal === "NEGATIVE" ? "neg" : ""}>{r.insider.signal}</b>
            {r.insider.score_breakdown[0] && <span className="dim" dir="ltr"> — {r.insider.score_breakdown.map((b) => b.label).join("; ")}</span>}
          </div>
        </div>
      </div>

      {r.warnings.length > 0 && <div className="warns" dir="ltr">{r.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}</div>}

      <div className="tabs">
        {(["evidence", "insiders", "market", "score", "history", "audit"] as Tab[]).map((x) => (
          <button key={x} className={tab === x ? "on" : ""} onClick={() => setTab(x)}>{tabLabel[x]}</button>
        ))}
      </div>

      {tab === "evidence" && <EvidenceTab t={t} r={r} />}
      {tab === "insiders" && <InsiderTab t={t} r={r} />}
      {tab === "market" && <MarketTab t={t} r={r} />}
      {tab === "score" && <ScoreTab t={t} r={r} />}
      {tab === "history" && <FilingsTab t={t} r={r} />}
      {tab === "audit" && <AuditTab t={t} r={r} giveFeedback={giveFeedback} />}
    </>
  );
}

function EvidenceTab({ t, r }: { t: Dict; r: Report }) {
  if (!r.evidence.length) return <div className="panel muted">{t.noEvidence}</div>;
  const primary = r.primary_catalyst.evidence_ids[0];
  return (
    <div className="panel">
      {r.evidence.map((e) => (
        <div key={e.id} className={`ev ${e.id === primary ? "primary" : ""}`}>
          <div><a href={e.source_url} target="_blank" rel="noreferrer" dir="ltr">{e.headline}</a> {e.id === primary && <span className="pill acc">{t.primary}</span>}
            {r.primary_catalyst.evidence_ids.includes(e.id) && e.id !== primary && <span className="pill">{t.cited}</span>}</div>
          <div className="meta"><span className="mono">{e.id}</span><span dir="ltr">{e.source_name}</span><span className="mono">{et(e.first_public_timestamp)}</span></div>
          {e.excerpt && <details><summary>{t.excerpt}</summary><pre className="ex" dir="ltr">{e.excerpt}</pre></details>}
        </div>
      ))}
    </div>
  );
}

function InsiderTab({ t, r }: { t: Dict; r: Report }) {
  const ins = r.insider;
  return (
    <div className="grid" style={{ gap: 14 }}>
      <div className="panel">
        <div>{t.signal} <b className={ins.signal === "POSITIVE" ? "pos" : ins.signal === "NEGATIVE" ? "neg" : ""}>{ins.signal}</b> · {t.score} <span className="mono">{ins.score}</span> · <span className="mono">{ins.form4_count}</span> {t.form4Parsed}</div>
        {ins.score_breakdown.length > 0 && <ul className="small" dir="ltr">{ins.score_breakdown.map((b, i) => <li key={i}><span className="mono">{b.points > 0 ? "+" : ""}{b.points}</span> {b.label}</li>)}</ul>}
        <div className="small dim">{t.insiderNote}</div>
      </div>
      <div className="panel tablewrap">
        <table>
          <thead><tr><th>{t.thTradeDate}</th><th>{t.thInsider}</th><th>{t.thTitle}</th><th>{t.thCode}</th><th className="n">{t.thShares}</th><th className="n">{t.thPrice}</th><th className="n">{t.thValue}</th><th className="n">{t.thOwn}</th><th></th></tr></thead>
          <tbody>
            {ins.transactions.length === 0 && <tr><td colSpan={9} className="muted">{t.noTx}</td></tr>}
            {ins.transactions.map((x, i) => (
              <tr key={i}>
                <td className="mono">{x.trade_date}</td><td dir="ltr">{x.owner}</td><td className="small" dir="ltr">{x.title}</td>
                <td className={`mono ${x.code === "P" ? "pos" : x.code === "S" ? "neg" : "dim"}`}>{x.code}{x.plan_10b5_1 ? "*" : ""}</td>
                <td className="n">{x.acquired_disposed === "D" ? "−" : ""}{x.shares.toLocaleString()}</td>
                <td className="n">{x.price === null ? "—" : x.price.toFixed(2)}</td>
                <td className="n">{money(x.value)}</td>
                <td className="n">{x.pct_change_ownership === null ? "—" : sgn(x.pct_change_ownership, 0)}</td>
                <td><a href={x.source_url} target="_blank" rel="noreferrer">SEC</a></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="small dim" style={{ marginTop: 6 }}>{t.planNote}</div>
      </div>
    </div>
  );
}

function Spark({ data, high }: { data: Report["market_context"]["history"]; high: number | null }) {
  const w = 600, h = 120, pad = 4;
  const geo = useMemo(() => {
    if (data.length < 2) return null;
    const lo = Math.min(...data.map((d) => d.low));
    const hi = Math.max(...data.map((d) => d.high), high ?? -Infinity);
    const y = (v: number) => h - pad - ((v - lo) / (hi - lo || 1)) * (h - 2 * pad);
    const pts = data.map((d, i) => `${pad + (i / (data.length - 1)) * (w - 2 * pad)},${y(d.close)}`).join(" ");
    return { pts, hy: high ? y(high) : null };
  }, [data, high]);
  if (!geo) return null;
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ direction: "ltr" }}>
      {geo.hy !== null && <line x1={0} x2={w} y1={geo.hy} y2={geo.hy} stroke="var(--warn)" strokeDasharray="4 4" strokeWidth={1} />}
      <polyline points={geo.pts} fill="none" stroke="var(--accent)" strokeWidth={1.8} />
    </svg>
  );
}

function MarketTab({ t, r }: { t: Dict; r: Report }) {
  const m = r.market_context;
  if (!m.available) return <div className="panel warn">{t.marketNA}: <span dir="ltr">{m.error}</span></div>;
  const rows: [string, string, string?][] = [
    [t.mStock, sgn(m.stock_move_pct), cls(m.stock_move_pct)],
    [t.mGap, sgn(m.stock_gap_pct), cls(m.stock_gap_pct)],
    [`${t.mSector} (${m.sector_etf})`, sgn(m.sector_move_pct), cls(m.sector_move_pct)],
    ["SPY", sgn(m.spy_move_pct), cls(m.spy_move_pct)],
    ["QQQ", sgn(m.qqq_move_pct), cls(m.qqq_move_pct)],
    [t.mRel, sgn(m.relative_return_to_sector), cls(m.relative_return_to_sector)],
    [t.mRvol, m.relative_volume === null ? "—" : `${m.relative_volume.toFixed(2)}x`],
    [t.mAtr, f(m.atr_pct, 2, "%")],
    [t.mGapAtr, f(m.gap_vs_atr, 2, "×")],
    [t.mD0, f(m.d0_high, 2)],
    [t.mBar, m.bar_date ?? "—"],
  ];
  return (
    <div className="grid g2">
      <div className="panel tablewrap"><table><tbody>{rows.map(([k, v, c]) => <tr key={k}><td className="muted">{k}</td><td className={`n ${c ?? ""}`}>{v}</td></tr>)}</tbody></table></div>
      <div className="panel">
        <div className="small muted">{t.last60}{r.breakout?.breakout_high ? t.dashed : ""}</div>
        <Spark data={m.history} high={r.breakout?.breakout_high || null} />
        <div className="small dim" style={{ marginTop: 8 }} dir="ltr">{m.provider}</div>
        <div className="small dim" style={{ marginTop: 6 }}>{t.ruleOfThumb}</div>
      </div>
    </div>
  );
}

function ScoreTab({ t, r }: { t: Dict; r: Report }) {
  const [W, setW] = useState(6), [L, setL] = useState(4), [C, setC] = useState(0.3);
  const pStar = W + L > 0 ? (L + C) / (W + L) : 1;
  const p = r.probability_no_averaging;
  const ev = p === null ? null : p * W - (1 - p) * L - C;
  return (
    <div className="grid g2">
      <div className="panel tablewrap">
        <table>
          <thead><tr><th>{t.thComponent}</th><th className="n">{t.thPoints}</th><th className="n">{t.thMax}</th><th>{t.thBasis}</th></tr></thead>
          <tbody>
            {r.score_components.map((c) => (
              <tr key={c.key}><td dir="ltr">{c.sign < 0 ? "− " : "+ "}{c.label}</td><td className={`n ${c.sign < 0 && c.value > 0 ? "neg" : ""}`}>{c.value.toFixed(1)}</td><td className="n dim">{c.max}</td><td className="small muted" dir="ltr">{c.why}</td></tr>
            ))}
            <tr><td><b>{t.rawScore}</b></td><td className="n"><b>{r.raw_score.toFixed(1)}</b></td><td className="n dim">100</td><td /></tr>
          </tbody>
        </table>
        <div className="small dim" style={{ marginTop: 8 }} dir="ltr">{r.probability_basis}</div>
        <div className="small" style={{ marginTop: 12 }}><b>{t.confBreakdown}</b></div>
        <ul className="small" dir="ltr">{r.confidence_breakdown.map((b, i) => <li key={i}><span className="mono">{b.points > 0 ? "+" : ""}{b.points}</span> {b.label}</li>)}</ul>
      </div>
      <div className="panel">
        <div><b>{t.evTitle}</b></div>
        <p className="small muted">{t.evBody}</p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <label className="small muted">{t.avgGain}<br /><input type="number" step="0.1" value={W} onChange={(e) => setW(Number(e.target.value))} style={{ width: 90 }} /></label>
          <label className="small muted">{t.avgLoss}<br /><input type="number" step="0.1" value={L} onChange={(e) => setL(Number(e.target.value))} style={{ width: 90 }} /></label>
          <label className="small muted">{t.costs}<br /><input type="number" step="0.05" value={C} onChange={(e) => setC(Number(e.target.value))} style={{ width: 90 }} /></label>
        </div>
        <div className="kv" style={{ marginTop: 14 }}>
          <span className="k">{t.breakEven}</span><span className="mono">{(pStar * 100).toFixed(1)}%</span>
          <span className="k">{t.modelP}</span><span className="mono">{p === null ? t.suppressed : `${(p * 100).toFixed(1)}%`}</span>
          <span className="k">{t.evTrade}</span><span className={`mono ${ev === null ? "" : ev >= 0 ? "pos" : "neg"}`}>{ev === null ? "—" : `${ev >= 0 ? "+" : ""}${ev.toFixed(2)}%`}</span>
          <span className="k">{t.verdict}</span><span>{p === null ? t.waitConfirm : p >= pStar ? <span className="pos">{t.aboveEv}</span> : <span className="warn">{t.belowEv}</span>}</span>
        </div>
        <div className="small dim" style={{ marginTop: 12 }}>{t.labelsNote}</div>
      </div>
    </div>
  );
}

function FilingsTab({ t, r }: { t: Dict; r: Report }) {
  return (
    <div className="panel tablewrap">
      <table>
        <thead><tr><th>{t.thAccepted}</th><th>{t.thForm}</th><th>{t.thDesc}</th></tr></thead>
        <tbody>{r.filings.map((x, i) => <tr key={i}><td className="mono small">{et(x.filed_at)}</td><td className="mono">{x.form}</td><td dir="ltr"><a href={x.url} target="_blank" rel="noreferrer">{x.description}</a></td></tr>)}</tbody>
      </table>
    </div>
  );
}

function AuditTab({ t, r, giveFeedback }: { t: Dict; r: Report; giveFeedback: (l: string) => void }) {
  const [sent, setSent] = useState<string | null>(null);
  const a = r.audit;
  return (
    <div className="grid g2">
      <div className="panel">
        <div className="kv">
          <span className="k">{t.aModel}</span><span className="mono">{a.model_version}</span>
          <span className="k">{t.aSkill}</span><span className="mono">{a.skill_version}</span>
          <span className="k">{t.aScoring}</span><span className="mono">{a.scoring_version}</span>
          <span className="k">{t.aCalib}</span><span className="mono small">{a.calibration_version}</span>
          <span className="k">{t.aInput}</span><span className="mono">{a.input_timestamp}</span>
          <span className="k">{t.aAsOf}</span><span className="mono">{r.as_of}</span>
          <span className="k">{t.aSources}</span><span className="mono">{a.source_timestamps.length}</span>
          <span className="k">{t.aRun}</span><span className="mono">{a.run_ms} ms</span>
        </div>
        <button className="btn ghost small" style={{ marginTop: 12 }} onClick={() => {
          const blob = new Blob([JSON.stringify(r, null, 2)], { type: "application/json" });
          const el = document.createElement("a"); el.href = URL.createObjectURL(blob); el.download = `${r.ticker}-${r.as_of}.json`; el.click();
        }}>{t.download}</button>
      </div>
      <div className="panel fb">
        <div><b>{t.feedback}</b> <span className="small dim">{t.feedbackNote}</span></div>
        {["correct catalyst", "wrong catalyst", "averaging happened", "no averaging"].map((l) => (
          <button key={l} className="btn ghost small" onClick={() => { giveFeedback(l); setSent(l); }}>{t.fbLabels[l]}</button>
        ))}
        {sent && <div className="small pos" style={{ marginTop: 8 }}>{t.recorded}: “{t.fbLabels[sent]}”</div>}
      </div>
    </div>
  );
}
