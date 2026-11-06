"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { BreakoutPattern, Report } from "@/lib/types";
import { CATEGORY_LABEL } from "@/lib/taxonomy";

type Tab = "evidence" | "insiders" | "market" | "score" | "history" | "audit";
interface WatchItem { ticker: string; p: number | null; conf: number | null; at: string; alerted?: boolean }
interface Feedback { ticker: string; as_of: string; category: string; p: number | null; label: string; at: string }

const LS_WATCH = "mticker.watchlist.v1";
const LS_FB = "mticker.feedback.v1";
const LS_ALERT = "mticker.alertThreshold.v1";

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

  useEffect(() => {
    setWatch(load<WatchItem[]>(LS_WATCH, []));
    setFeedback(load<Feedback[]>(LS_FB, []));
    setAlertThr(load<number>(LS_ALERT, 0.65));
    const q = new URLSearchParams(window.location.search).get("t");
    if (q) { setTicker(q.toUpperCase()); void run(q.toUpperCase()); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = useCallback(
    async (tk?: string) => {
      const t = (tk ?? ticker).trim().toUpperCase();
      if (!t) return;
      setLoading(true); setErr(null);
      try {
        const body: Record<string, unknown> = { ticker: t, threshold };
        if (asOf) body.as_of = new Date(asOf).toISOString();
        if (mode === "breakout") body.breakout = { confirmed_by_user: true, pattern, breakout_date: bDate, breakout_high: Number(bHigh) || 0 };
        const rep = await fetchReport(body);
        setR(rep);
        setTab("evidence");
        history.replaceState(null, "", `?t=${t}`);
        setWatch((w) => {
          const nw = w.map((x) => (x.ticker === t ? { ...x, p: rep.probability_no_averaging, conf: rep.confidence, at: rep.as_of } : x));
          save(LS_WATCH, nw);
          return nw;
        });
      } catch (e) {
        setErr((e as Error).message); setR(null);
      } finally { setLoading(false); }
    },
    [ticker, threshold, asOf, mode, pattern, bDate, bHigh],
  );

  const inWatch = r ? watch.some((w) => w.ticker === r.ticker) : false;
  const toggleWatch = () => {
    if (!r) return;
    const nw = inWatch ? watch.filter((w) => w.ticker !== r.ticker) : [...watch, { ticker: r.ticker, p: r.probability_no_averaging, conf: r.confidence, at: r.as_of }];
    setWatch(nw); save(LS_WATCH, nw);
  };
  const removeWatch = (t: string) => { const nw = watch.filter((w) => w.ticker !== t); setWatch(nw); save(LS_WATCH, nw); };

  const refreshWatch = async () => {
    setRefreshing(true);
    const fired: string[] = [];
    const next: WatchItem[] = [];
    for (const w of watch) {
      try {
        const rep = await fetchReport({ ticker: w.ticker });
        const p = rep.probability_no_averaging;
        const crossed = p !== null && p >= alertThr && (w.p === null || w.p < alertThr);
        if (crossed) fired.push(`${w.ticker}: P(no averaging) crossed ${Math.round(alertThr * 100)}% → ${Math.round(p! * 100)}% (${CATEGORY_LABEL[rep.primary_catalyst.category]})`);
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
    <div className="shell">
      <aside className="side">
        <div className="brand"><span className="brand-dot" /> M-Ticker</div>
        <div className="brand-sub">Breakout continuation intelligence</div>

        <h4>Watchlist</h4>
        {watch.length === 0 && <div className="dim small">Analyze a ticker and add it here.</div>}
        {watch.map((w) => (
          <div key={w.ticker} className={`wl-item ${r?.ticker === w.ticker ? "active" : ""}`} onClick={() => { setTicker(w.ticker); void run(w.ticker); }}>
            <span className="wl-t">{w.ticker}{w.alerted ? " 🔔" : ""}</span>
            <span className="wl-p">{w.p === null ? "—" : `${Math.round(w.p * 100)}%`} · {w.conf ?? "—"}</span>
            <button className="x" title="Remove" onClick={(e) => { e.stopPropagation(); removeWatch(w.ticker); }}>×</button>
          </div>
        ))}
        {watch.length > 0 && (
          <button className="btn ghost small" style={{ marginTop: 8, width: "100%" }} disabled={refreshing} onClick={refreshWatch}>
            {refreshing ? <><span className="loader" />Refreshing…</> : "Refresh scores"}
          </button>
        )}

        <h4>Alerts</h4>
        <label className="small muted" style={{ display: "flex", alignItems: "center", gap: 6 }}>
          Alert when P ≥
          <input type="number" min={0.05} max={0.95} step={0.05} value={alertThr} style={{ width: 70, padding: "4px 6px" }}
            onChange={(e) => { const v = Number(e.target.value); setAlertThr(v); save(LS_ALERT, v); }} />
        </label>
        {alerts.length === 0 ? <div className="dim small" style={{ marginTop: 6 }}>No alerts yet.</div> :
          alerts.map((a, i) => <div key={i} className="small warn" style={{ marginTop: 6 }}>{a}</div>)}

        <h4>Model audit ({feedback.length})</h4>
        {feedback.slice(0, 6).map((fb, i) => (
          <div key={i} className="small" style={{ marginBottom: 4 }}>
            <span className="mono">{fb.ticker}</span> <span className="dim">{fb.p === null ? "—" : `${Math.round(fb.p * 100)}%`}</span> → <span className="muted">{fb.label}</span>
          </div>
        ))}
        {feedback.length > 0 && (
          <button className="btn ghost small" style={{ marginTop: 6, width: "100%" }} onClick={() => {
            const blob = new Blob([JSON.stringify(feedback, null, 2)], { type: "application/json" });
            const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "mticker-feedback.json"; a.click();
          }}>Export labels (JSON)</button>
        )}
      </aside>

      <main className="main">
        <form className="search" onSubmit={(e) => { e.preventDefault(); void run(); }}>
          <label>Ticker<input className="tk" value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} placeholder="ABCD" autoFocus /></label>
          <label>Mode
            <span className="seg">
              <button type="button" className={mode === "scan" ? "on" : ""} onClick={() => setMode("scan")}>Live event scan</button>
              <button type="button" className={mode === "breakout" ? "on" : ""} onClick={() => setMode("breakout")}>Breakout decision</button>
            </span>
          </label>
          {mode === "breakout" && (
            <>
              <label>Pattern
                <select value={pattern} onChange={(e) => setPattern(e.target.value as BreakoutPattern)}>
                  <option value="PEAK">PEAK</option><option value="CENTER">CENTER</option><option value="BOTTOM">BOTTOM</option>
                </select>
              </label>
              <label>Breakout date<input type="date" value={bDate} onChange={(e) => setBDate(e.target.value)} /></label>
              <label>D0 high<input type="number" step="0.01" value={bHigh} onChange={(e) => setBHigh(e.target.value)} style={{ width: 100 }} /></label>
              <label>Entry threshold<input type="number" min={0.05} max={0.95} step={0.01} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} style={{ width: 80 }} /></label>
            </>
          )}
          <label>As of (replay)<input type="datetime-local" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></label>
          <button className="btn" disabled={loading || !ticker}>{loading ? <><span className="loader" />Analyzing</> : "Analyze"}</button>
        </form>

        {err && <div className="err">{err}</div>}
        {!r && !err && !loading && <Empty />}
        {loading && !r && <div className="empty"><span className="loader" /> Resolving entity, pulling SEC / FDA / Form 4 / market data, classifying…</div>}

        {r && (
          <ReportView r={r} tab={tab} setTab={setTab} inWatch={inWatch} toggleWatch={toggleWatch} giveFeedback={giveFeedback} threshold={threshold} />
        )}

        <div className="foot">
          Decision support only — not investment advice and not an execution system. Probabilities are produced by a seed scoring model that is
          <b> not yet calibrated</b> on a point-in-time backtest; treat them as ranked scores until a calibration set (300–500 events) is in place.
          Sources: SEC EDGAR (official), openFDA Drugs@FDA (official), Yahoo Finance chart data (development only — replace with a licensed feed for production).
        </div>
      </main>
    </div>
  );
}

function Empty() {
  return (
    <div className="empty">
      <h2>Is this breakout news-driven enough to skip the averaging candle?</h2>
      <div>Enter a US-listed ticker. The engine resolves the SEC entity, collects filings, FDA actions and Form 4s up to the as-of time,
        classifies the primary catalyst, compares the move against its sector and returns <span className="mono">P(no averaging)</span> with a separate confidence score.</div>
    </div>
  );
}

function stateClass(r: Report) {
  if (r.status === "CONFLICTING_INFORMATION") return "stop";
  if (r.action === "ENTRY_CANDIDATE") return "go";
  return "wait";
}

function ReportView({ r, tab, setTab, inWatch, toggleWatch, giveFeedback, threshold }: {
  r: Report; tab: Tab; setTab: (t: Tab) => void; inWatch: boolean; toggleWatch: () => void; giveFeedback: (l: string) => void; threshold: number;
}) {
  const m = r.market_context;
  const pc = r.primary_catalyst;
  const p = r.probability_no_averaging;
  const pColor = p === null ? "var(--warn)" : p >= threshold ? "var(--pos)" : p >= 0.45 ? "var(--warn)" : "var(--neg)";
  const freshCls = r.freshness === "HIGH" ? "pos" : r.freshness === "MEDIUM" ? "acc" : r.freshness === "LOW" ? "warn" : "neg";

  return (
    <>
      <div className="head">
        <span className="t">{r.ticker}</span>
        <span className="px">{m.last_price !== null ? `$${m.last_price.toFixed(2)}` : "—"}</span>
        <span className={`px ${cls(m.stock_move_pct)}`}>{sgn(m.stock_move_pct)}</span>
        <span className="co">{r.entity.company_name} · {r.entity.exchange ?? "—"} · {r.entity.sector ?? r.entity.industry ?? "—"}</span>
        <span style={{ flex: 1 }} />
        <button className="btn ghost small" onClick={toggleWatch}>{inWatch ? "★ In watchlist" : "☆ Add to watchlist"}</button>
      </div>

      <div className="event">
        <span className={`pill ${r.significant_event_now ? "pos" : ""}`}>{r.significant_event_now ? "● Event detected" : "No significant event now"}</span>
        <span className="pill acc">{pc.category}</span>
        <span className={`pill ${freshCls}`}>Freshness: {r.freshness}</span>
        {r.historical_replay && <span className="pill warn">Historical replay · as of {et(r.as_of)}</span>}
        <span className="pill">{pc.engine === "claude" ? `Claude · ${pc.model ?? ""}` : "Rules engine"}</span>
      </div>

      <div className="grid g4">
        <div className="panel tile">
          <div className="k">P(no averaging)</div>
          <div className="v" style={{ color: pColor }}>{p === null ? "SUPPRESSED" : `${Math.round(p * 100)}%`}</div>
          <div className="bar"><i style={{ width: `${(p ?? 0) * 100}%`, background: pColor }} /></div>
          <div className="s">seed model · uncalibrated</div>
        </div>
        <div className="panel tile">
          <div className="k">Confidence</div>
          <div className="v">{r.confidence}<span className="dim" style={{ fontSize: 16 }}>/100</span></div>
          <div className="bar"><i style={{ width: `${r.confidence}%`, background: "var(--accent)" }} /></div>
          <div className="s">{r.confidence >= 75 ? "HIGH" : r.confidence >= 50 ? "MEDIUM" : "LOW"} — evidence quality & completeness</div>
        </div>
        <div className="panel tile">
          <div className="k">Raw catalyst score</div>
          <div className="v">{r.raw_score.toFixed(0)}<span className="dim" style={{ fontSize: 16 }}>/100</span></div>
          <div className="bar"><i style={{ width: `${r.raw_score}%`, background: "var(--muted)" }} /></div>
          <div className="s">heuristic, pre-calibration</div>
        </div>
        <div className="panel tile">
          <div className="k">Breakout context</div>
          <div className="v" style={{ fontSize: 24 }}>{r.breakout ? r.breakout.pattern : "—"}</div>
          <div className="s">{r.breakout ? `${r.breakout.breakout_date || "date n/a"} · D0 high ${r.breakout.breakout_high || "—"}` : "Live event scan (no breakout input)"}</div>
        </div>
      </div>

      <div className={`state ${stateClass(r)}`}>
        {r.system_state ?? r.action}
        {r.status === "CONFLICTING_INFORMATION" && " — high-authority sources disagree; probability suppressed"}
      </div>

      <div className="grid g2" style={{ marginTop: 14 }}>
        <div className="panel">
          <div className="kv">
            <span className="k">Primary catalyst</span><span><b>{pc.headline}</b></span>
            <span className="k">First public time</span><span className="mono">{et(pc.event_time)}{r.hours_since_event !== null && <span className="dim"> ({r.hours_since_event.toFixed(1)}h ago)</span>}</span>
            <span className="k">Classification</span><span className="mono">{pc.category}</span>
            <span className="k">New vs known</span><span>{pc.new_or_materialization}</span>
            <span className="k">Primary source</span><span>{pc.source_url ? <a href={pc.source_url} target="_blank" rel="noreferrer">{pc.source_type}</a> : "—"}</span>
            <span className="k">Causal attribution</span><span className={pc.causal_attribution === "LOW" ? "warn" : ""}>{pc.causal_attribution}</span>
            {pc.secondary_catalysts.length > 0 && (<><span className="k">Secondary</span><span className="mono small">{pc.secondary_catalysts.join(", ")}</span></>)}
          </div>
        </div>
        <div className="panel">
          <div className="k muted small" style={{ textTransform: "uppercase", letterSpacing: ".06em" }}>Why</div>
          <p className="why">{pc.reasoning_summary}</p>
          {pc.possible_drivers.length > 0 && <p className="small muted">Possible drivers: {pc.possible_drivers.join(" · ")}</p>}
          <div className="small"><span className="warn">Main risk:</span> {pc.main_risk}</div>
          {pc.conflicts.length > 0 && <div className="small neg" style={{ marginTop: 6 }}>Conflicts: {pc.conflicts.join("; ")}</div>}
          <div className="small" style={{ marginTop: 8 }}>
            <span className="muted">Insiders:</span> <b className={r.insider.signal === "POSITIVE" ? "pos" : r.insider.signal === "NEGATIVE" ? "neg" : ""}>{r.insider.signal}</b>
            {r.insider.score_breakdown[0] && <span className="dim"> — {r.insider.score_breakdown.map((b) => b.label).join("; ")}</span>}
          </div>
        </div>
      </div>

      {r.warnings.length > 0 && <div className="warns">{r.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}</div>}

      <div className="tabs">
        {(["evidence", "insiders", "market", "score", "history", "audit"] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
            {{ evidence: `Evidence (${r.evidence.length})`, insiders: `Insiders (${r.insider.transactions.length})`, market: "Market context", score: "Score & EV", history: `Filings (${r.filings.length})`, audit: "Audit & feedback" }[t]}
          </button>
        ))}
      </div>

      {tab === "evidence" && <EvidenceTab r={r} />}
      {tab === "insiders" && <InsiderTab r={r} />}
      {tab === "market" && <MarketTab r={r} />}
      {tab === "score" && <ScoreTab r={r} />}
      {tab === "history" && <FilingsTab r={r} />}
      {tab === "audit" && <AuditTab r={r} giveFeedback={giveFeedback} />}
    </>
  );
}

function EvidenceTab({ r }: { r: Report }) {
  if (!r.evidence.length) return <div className="panel muted">No filings or FDA actions found before as-of in the lookback window.</div>;
  const primary = r.primary_catalyst.evidence_ids[0];
  return (
    <div className="panel">
      {r.evidence.map((e) => (
        <div key={e.id} className={`ev ${e.id === primary ? "primary" : ""}`}>
          <div><a href={e.source_url} target="_blank" rel="noreferrer">{e.headline}</a> {e.id === primary && <span className="pill acc">primary</span>}
            {r.primary_catalyst.evidence_ids.includes(e.id) && e.id !== primary && <span className="pill">cited</span>}</div>
          <div className="meta"><span className="mono">{e.id}</span><span>{e.source_name}</span><span>{et(e.first_public_timestamp)}</span></div>
          {e.excerpt && <details><summary>Source text excerpt</summary><pre className="ex">{e.excerpt}</pre></details>}
        </div>
      ))}
    </div>
  );
}

function InsiderTab({ r }: { r: Report }) {
  const ins = r.insider;
  return (
    <div className="grid" style={{ gap: 14 }}>
      <div className="panel">
        <div>Signal <b className={ins.signal === "POSITIVE" ? "pos" : ins.signal === "NEGATIVE" ? "neg" : ""}>{ins.signal}</b> · score <span className="mono">{ins.score}</span> · {ins.form4_count} Form 4 filings parsed (last ~90 days)</div>
        {ins.score_breakdown.length > 0 && <ul className="small">{ins.score_breakdown.map((b, i) => <li key={i}><span className="mono">{b.points > 0 ? "+" : ""}{b.points}</span> {b.label}</li>)}</ul>}
        <div className="small dim">Only code P open-market purchases count as conviction. A / M / F / G codes and 10b5-1 plan trades are not weighted. Insider buying confirms; it is rarely the catalyst itself.</div>
      </div>
      <div className="panel tablewrap">
        <table>
          <thead><tr><th>Trade date</th><th>Insider</th><th>Title</th><th>Code</th><th className="n">Shares</th><th className="n">Price</th><th className="n">Value</th><th className="n">Δ own</th><th></th></tr></thead>
          <tbody>
            {ins.transactions.length === 0 && <tr><td colSpan={9} className="muted">No non-derivative Form 4 transactions found.</td></tr>}
            {ins.transactions.map((t, i) => (
              <tr key={i}>
                <td className="mono">{t.trade_date}</td><td>{t.owner}</td><td className="small">{t.title}</td>
                <td className={`mono ${t.code === "P" ? "pos" : t.code === "S" ? "neg" : "dim"}`}>{t.code}{t.plan_10b5_1 ? "*" : ""}</td>
                <td className="n">{t.acquired_disposed === "D" ? "−" : ""}{t.shares.toLocaleString()}</td>
                <td className="n">{t.price === null ? "—" : t.price.toFixed(2)}</td>
                <td className="n">{money(t.value)}</td>
                <td className="n">{t.pct_change_ownership === null ? "—" : sgn(t.pct_change_ownership, 0)}</td>
                <td><a href={t.source_url} target="_blank" rel="noreferrer">SEC</a></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="small dim" style={{ marginTop: 6 }}>* 10b5-1 plan</div>
      </div>
    </div>
  );
}

function Spark({ data, high }: { data: Report["market_context"]["history"]; high: number | null }) {
  const w = 600, h = 120, pad = 4;
  const pts = useMemo(() => {
    if (data.length < 2) return "";
    const lo = Math.min(...data.map((d) => d.low)), hi = Math.max(...data.map((d) => d.high), high ?? -Infinity);
    return data.map((d, i) => `${pad + (i / (data.length - 1)) * (w - 2 * pad)},${h - pad - ((d.close - lo) / (hi - lo || 1)) * (h - 2 * pad)}`).join(" ");
  }, [data, high]);
  if (!pts) return null;
  const lo = Math.min(...data.map((d) => d.low)), hi = Math.max(...data.map((d) => d.high), high ?? -Infinity);
  const hy = high ? h - pad - ((high - lo) / (hi - lo || 1)) * (h - 2 * pad) : null;
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      {hy !== null && <line x1={0} x2={w} y1={hy} y2={hy} stroke="var(--warn)" strokeDasharray="4 4" strokeWidth={1} />}
      <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth={1.8} />
    </svg>
  );
}

function MarketTab({ r }: { r: Report }) {
  const m = r.market_context;
  if (!m.available) return <div className="panel warn">Market data unavailable: {m.error}</div>;
  const rows: [string, string, string?][] = [
    ["Stock return (day)", sgn(m.stock_move_pct), cls(m.stock_move_pct)],
    ["Gap at open", sgn(m.stock_gap_pct), cls(m.stock_gap_pct)],
    [`Sector ETF (${m.sector_etf})`, sgn(m.sector_move_pct), cls(m.sector_move_pct)],
    ["SPY", sgn(m.spy_move_pct), cls(m.spy_move_pct)],
    ["QQQ", sgn(m.qqq_move_pct), cls(m.qqq_move_pct)],
    ["Relative return to sector", sgn(m.relative_return_to_sector), cls(m.relative_return_to_sector)],
    ["Relative volume (vs 20d)", m.relative_volume === null ? "—" : `${m.relative_volume.toFixed(2)}x`],
    ["ATR(14) %", f(m.atr_pct, 2, "%")],
    ["Gap vs ATR", f(m.gap_vs_atr, 2, "×")],
    ["D0 high", f(m.d0_high, 2)],
    ["Bar date", m.bar_date ?? "—"],
  ];
  return (
    <div className="grid g2">
      <div className="panel tablewrap"><table><tbody>{rows.map(([k, v, c]) => <tr key={k}><td className="muted">{k}</td><td className={`n ${c ?? ""}`}>{v}</td></tr>)}</tbody></table></div>
      <div className="panel">
        <div className="small muted">Last 60 sessions · close{r.breakout?.breakout_high ? " · dashed = breakout high" : ""}</div>
        <Spark data={m.history} high={r.breakout?.breakout_high || null} />
        <div className="small dim" style={{ marginTop: 8 }}>{m.provider}</div>
        <div className="small dim" style={{ marginTop: 6 }}>
          Rule of thumb from the spec: peers +6–8% and stock +7% with no specific news ⇒ SECTOR_SYMPATHY; stock +13% vs sector +1.5% after a contract filing ⇒ company-specific.
        </div>
      </div>
    </div>
  );
}

function ScoreTab({ r }: { r: Report }) {
  const [W, setW] = useState(6), [L, setL] = useState(4), [C, setC] = useState(0.3);
  const pStar = W + L > 0 ? (L + C) / (W + L) : 1;
  const p = r.probability_no_averaging;
  const ev = p === null ? null : p * W - (1 - p) * L - C;
  return (
    <div className="grid g2">
      <div className="panel tablewrap">
        <table>
          <thead><tr><th>Component</th><th className="n">Points</th><th className="n">Max</th><th>Basis</th></tr></thead>
          <tbody>
            {r.score_components.map((c) => (
              <tr key={c.key}><td>{c.sign < 0 ? "− " : "+ "}{c.label}</td><td className={`n ${c.sign < 0 && c.value > 0 ? "neg" : ""}`}>{c.value.toFixed(1)}</td><td className="n dim">{c.max}</td><td className="small muted">{c.why}</td></tr>
            ))}
            <tr><td><b>Raw score</b></td><td className="n"><b>{r.raw_score.toFixed(1)}</b></td><td className="n dim">100</td><td /></tr>
          </tbody>
        </table>
        <div className="small dim" style={{ marginTop: 8 }}>{r.probability_basis}</div>
        <div className="small" style={{ marginTop: 12 }}><b>Confidence breakdown</b></div>
        <ul className="small">{r.confidence_breakdown.map((b, i) => <li key={i}><span className="mono">{b.points > 0 ? "+" : ""}{b.points}</span> {b.label}</li>)}</ul>
      </div>
      <div className="panel">
        <div><b>Entry threshold from expected value</b></div>
        <p className="small muted">The threshold should come from EV, not from a probability that "sounds high". EV = p·W − (1−p)·L − C, minimum p* = (L + C) / (W + L).</p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <label className="small muted">Avg gain W %<br /><input type="number" step="0.1" value={W} onChange={(e) => setW(Number(e.target.value))} style={{ width: 90 }} /></label>
          <label className="small muted">Avg loss L %<br /><input type="number" step="0.1" value={L} onChange={(e) => setL(Number(e.target.value))} style={{ width: 90 }} /></label>
          <label className="small muted">Costs C %<br /><input type="number" step="0.05" value={C} onChange={(e) => setC(Number(e.target.value))} style={{ width: 90 }} /></label>
        </div>
        <div className="kv" style={{ marginTop: 14 }}>
          <span className="k">Break-even p*</span><span className="mono">{(pStar * 100).toFixed(1)}%</span>
          <span className="k">Model P</span><span className="mono">{p === null ? "suppressed" : `${(p * 100).toFixed(1)}%`}</span>
          <span className="k">EV per trade</span><span className={`mono ${ev === null ? "" : ev >= 0 ? "pos" : "neg"}`}>{ev === null ? "—" : `${ev >= 0 ? "+" : ""}${ev.toFixed(2)}%`}</span>
          <span className="k">Verdict</span><span>{p === null ? "Wait for confirmation" : p >= pStar ? <span className="pos">Above EV threshold</span> : <span className="warn">Below EV threshold — wait for averaging candle</span>}</span>
        </div>
        <div className="small dim" style={{ marginTop: 12 }}>
          Labels: <b>Strict</b> = Low(D+1) &gt; High(D0) (gap-and-hold). <b>Practical</b> = no entry-qualifying pullback before the stock gains 5–10% or within 3 sessions.
        </div>
      </div>
    </div>
  );
}

function FilingsTab({ r }: { r: Report }) {
  return (
    <div className="panel tablewrap">
      <table>
        <thead><tr><th>Accepted (ET)</th><th>Form</th><th>Description</th></tr></thead>
        <tbody>{r.filings.map((x, i) => <tr key={i}><td className="mono small">{et(x.filed_at)}</td><td className="mono">{x.form}</td><td><a href={x.url} target="_blank" rel="noreferrer">{x.description}</a></td></tr>)}</tbody>
      </table>
    </div>
  );
}

function AuditTab({ r, giveFeedback }: { r: Report; giveFeedback: (l: string) => void }) {
  const [sent, setSent] = useState<string | null>(null);
  const a = r.audit;
  return (
    <div className="grid g2">
      <div className="panel">
        <div className="kv">
          <span className="k">Model version</span><span className="mono">{a.model_version}</span>
          <span className="k">Skill version</span><span className="mono">{a.skill_version}</span>
          <span className="k">Scoring version</span><span className="mono">{a.scoring_version}</span>
          <span className="k">Calibration</span><span className="mono small">{a.calibration_version}</span>
          <span className="k">Input timestamp</span><span className="mono">{a.input_timestamp}</span>
          <span className="k">As of</span><span className="mono">{r.as_of}</span>
          <span className="k">Sources</span><span className="mono">{a.source_timestamps.length}</span>
          <span className="k">Run time</span><span className="mono">{a.run_ms} ms</span>
        </div>
        <button className="btn ghost small" style={{ marginTop: 12 }} onClick={() => {
          const blob = new Blob([JSON.stringify(r, null, 2)], { type: "application/json" });
          const el = document.createElement("a"); el.href = URL.createObjectURL(blob); el.download = `${r.ticker}-${r.as_of}.json`; el.click();
        }}>Download full report JSON</button>
      </div>
      <div className="panel fb">
        <div><b>Feedback</b> <span className="small dim">— labels are stored in your browser and exportable for calibration</span></div>
        {["correct catalyst", "wrong catalyst", "averaging happened", "no averaging"].map((l) => (
          <button key={l} className="btn ghost small" onClick={() => { giveFeedback(l); setSent(l); }}>{l}</button>
        ))}
        {sent && <div className="small pos" style={{ marginTop: 8 }}>Recorded “{sent}”.</div>}
      </div>
    </div>
  );
}
