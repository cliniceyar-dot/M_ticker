"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Lang } from "@/lib/i18n";
import { BULLBEAR_DICTS, type BullBearDict } from "@/lib/i18n-bullbear";
import type { SourceGroup, SpecArgument, SpecResponse } from "@/lib/stocks/spec";

interface JobView {
  job_id: string;
  status: "queued" | "running" | "done" | "failed";
  progress: Record<string, string>;
  error: string | null;
}

const CLIENT_KEY = "mticker.clientId.v1";
function clientId(): string {
  try {
    let id = localStorage.getItem(CLIENT_KEY);
    if (!id) {
      id = (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9-]/g, "");
      localStorage.setItem(CLIENT_KEY, id);
    }
    return id;
  } catch {
    return "anonymous-client";
  }
}
const fmt = (iso: string | null) => (iso ? iso.slice(0, 10) : "—");
const fmtTime = (iso: string) => new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });

export default function BullBearPanel({ ticker, lang }: { ticker: string; lang: Lang }) {
  const t = BULLBEAR_DICTS[lang];
  const [data, setData] = useState<SpecResponse | null>(null);
  const [job, setJob] = useState<JobView | null>(null);
  const [previous, setPrevious] = useState<{ version: number; generated_at: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [types, setTypes] = useState<SourceGroup[]>([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const apiLang = lang === "en" ? "en" : "he";

  const query = useCallback(
    (extra: Record<string, string> = {}) => {
      const p = new URLSearchParams({ lang: apiLang, ...extra });
      if (types.length) p.set("source_types", types.join(","));
      if (from) p.set("from", from);
      if (to) p.set("to", to);
      return p.toString();
    },
    [apiLang, types, from, to],
  );

  const pollJob = useCallback(
    async (id: string, version?: number) => {
      if (timer.current) clearTimeout(timer.current);
      try {
        const r = await fetch(`/api/v1/jobs/${id}`);
        const j = (await r.json()) as JobView & { version: number | null };
        setJob(j);
        if (j.status === "done") {
          setJob(null);
          void load(j.version ?? version);
        } else if (j.status === "failed") {
          setErr(`${t.failed} ${j.error ?? ""}`.trim());
        } else {
          timer.current = setTimeout(() => void pollJob(id, version), 2500);
        }
      } catch (e) {
        setErr((e as Error).message);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t],
  );

  const load = useCallback(
    async (version?: number) => {
      setErr(null);
      try {
        const r = await fetch(`/api/v1/stocks/${encodeURIComponent(ticker)}/bull-bear?${query(version ? { version: String(version) } : {})}`);
        const j = await r.json();
        if (r.status === 202) {
          setPrevious(j.previous ?? null);
          void pollJob(j.job_id);
          return;
        }
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        setData(j as SpecResponse);
        setPrevious(null);
      } catch (e) {
        setErr((e as Error).message);
      }
    },
    [ticker, query, pollJob],
  );

  useEffect(() => {
    setData(null);
    void load();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker, apiLang]);

  const refresh = async () => {
    setNote(null);
    const r = await fetch(`/api/v1/stocks/${encodeURIComponent(ticker)}/bull-bear/refresh?lang=${apiLang}`, { method: "POST", headers: { "x-client-id": clientId() } });
    const j = await r.json();
    if (r.status === 429) {
      setNote(t.rateLimited(Math.ceil((j.retry_after_seconds ?? 3600) / 60)));
      return;
    }
    if (r.status === 202) void pollJob(j.job_id);
    else setErr(j.error || `HTTP ${r.status}`);
  };

  const toggle = (g: SourceGroup) => setTypes((xs) => (xs.includes(g) ? xs.filter((x) => x !== g) : [...xs, g]));

  return (
    <div className="bb">
      {data && (
        <div className="panel bb-head">
          <div>
            <b dir="ltr">{data.company_name}</b> <span className="mono">({data.ticker})</span>
            <div className="small dim">
              {t.generated}: <span className="mono">{fmtTime(data.generated_at)}</span> · <span className="mono">{data.sources_scanned}</span> {t.scanned} · {t.version}{" "}
              <span className="mono">{data.version}</span>
            </div>
          </div>
          <button className="btn ghost small" onClick={() => void refresh()} disabled={!!job}>
            {job ? t.refreshing : t.refresh}
          </button>
        </div>
      )}
      {note && <div className="warns">{note}</div>}
      {err && <div className="err" dir="auto">{err}</div>}

      {job && (
        <div className="panel bb-progress">
          <div>
            <span className="loader" /> {t.loading}
          </div>
          {previous && <div className="small dim">{t.previous} (v{previous.version}, {fmt(previous.generated_at)})</div>}
          <div className="small muted" style={{ marginTop: 8 }}>{t.progressTitle}</div>
          <ul className="bb-prog">
            {Object.entries(job.progress).map(([ch, st]) => (
              <li key={ch} className={st === "done" ? "pos" : st === "failed" ? "neg" : st === "running" ? "" : "dim"}>
                {t.channels[ch] ?? ch}… {t.progress[st] ?? st}
              </li>
            ))}
          </ul>
        </div>
      )}

      {data && (
        <>
          <Notices data={data} t={t} />
          <form className="bb-filters" onSubmit={(e) => { e.preventDefault(); void load(); }}>
            <span className="small muted">{t.filters}:</span>
            {(["official", "news", "social"] as SourceGroup[]).map((g) => (
              <label key={g} className="rs-chk">
                <input type="checkbox" checked={types.includes(g)} onChange={() => toggle(g)} /> {t[g]}
              </label>
            ))}
            <label className="small muted">{t.from} <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <label className="small muted">{t.to} <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
            <button className="btn ghost small">{t.apply}</button>
            {(types.length > 0 || from || to) && (
              <button type="button" className="btn ghost small" onClick={() => { setTypes([]); setFrom(""); setTo(""); setTimeout(() => void load(), 0); }}>
                {t.clear}
              </button>
            )}
          </form>

          {/* Fixed by spec: right = bull, left = bear (independent of text direction). */}
          <div className="rs-cols" dir="ltr">
            <section className="rs-col show" dir={lang === "he" ? "rtl" : "ltr"}>
              <h2 className="rs-colh neg">{t.bear}</h2>
              <Side args={data.bear} few={data.notices.includes("FEW_BEAR_ARGUMENTS")} t={t} lang={lang} />
            </section>
            <section className="rs-col show" dir={lang === "he" ? "rtl" : "ltr"}>
              <h2 className="rs-colh pos">{t.bull}</h2>
              <Side args={data.bull} few={data.notices.includes("FEW_BULL_ARGUMENTS")} t={t} lang={lang} />
            </section>
          </div>

          {data.summary && (
            <div className="panel" style={{ marginTop: 14 }}>
              <b>{t.bottomLine}</b>
              <p className="why" dir={lang === "he" ? "rtl" : "ltr"}>{data.summary}</p>
            </div>
          )}
        </>
      )}
      <div className="bb-disclaimer">{t.disclaimer}</div>
    </div>
  );
}

function Notices({ data, t }: { data: SpecResponse; t: BullBearDict }) {
  const out: string[] = [];
  for (const n of data.notices) {
    if (n === "FEW_BULL_ARGUMENTS" || n === "FEW_BEAR_ARGUMENTS") continue;
    if (n === "PARTIAL_HISTORY") out.push(`${t.notices.PARTIAL_HISTORY}: ${data.history_months} ${t.months}`);
    else if (n === "MISSING_SOURCES") out.push(`${t.notices.MISSING_SOURCES} ${data.missing_sources.join(", ")}`);
    else if (n === "STALE_ANALYSIS") out.push(`${t.notices.STALE_ANALYSIS} ${fmt(data.generated_at)}`);
    else out.push(t.notices[n] ?? n);
  }
  if (!out.length) return null;
  return <div className="warns">{out.map((x, i) => <div key={i}>⚠ {x}</div>)}</div>;
}

function Side({ args, few, t, lang }: { args: SpecArgument[]; few: boolean; t: BullBearDict; lang: Lang }) {
  return (
    <>
      {few && <div className="small warn" style={{ marginBottom: 8 }}>{t.few}</div>}
      {args.map((a) => <Card key={a.id} a={a} t={t} lang={lang} />)}
    </>
  );
}

function Card({ a, t, lang }: { a: SpecArgument; t: BullBearDict; lang: Lang }) {
  const cls = a.strength === "strong" ? "pos" : a.strength === "medium" ? "acc" : "warn";
  return (
    <article className="panel rs-arg">
      <div className="rs-argh"><b>{a.title}</b></div>
      <div className="rs-chips">
        <span className={`pill ${cls}`}>{t.strength[a.strength]}</span>
        {a.source_types.map((g) => <span key={g} className="pill">{t[g]}</span>)}
        {a.verified_against_sec && <span className="pill pos">✓ {t.secVerified}</span>}
        {a.conflict_flag && <span className="pill neg">⚠ {t.conflict}</span>}
        {a.labels.includes("social_opinion") && <span className="pill warn">{t.socialOpinion}</span>}
      </div>
      <p className="why">{a.explanation}</p>
      <details>
        <summary>{t.sources} ({a.sources.length})</summary>
        <ul className="rs-evlist" dir="ltr">
          {a.sources.map((s) => (
            <li key={s.source_item_id}>
              <a href={s.url} target="_blank" rel="noreferrer">{s.title}</a> <span className="dim small mono">{fmt(s.published_at)} · {s.type}</span>
              <div className="small muted" dir={lang === "he" ? "auto" : "ltr"}>{s.excerpt}</div>
            </li>
          ))}
        </ul>
      </details>
    </article>
  );
}
