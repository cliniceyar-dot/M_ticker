# M-Ticker: Breakout Continuation Intelligence

M-Ticker is an event-intelligence SaaS MVP. For a US-listed ticker it answers one question: **is the current catalyst strong, fresh and specific enough that the move will continue without an averaging candle?**

## Pipeline

```
Ticker → Entity Resolution → Event Collection → Evidence Normalization → Catalyst Classification
       → Market Context → Insider Analysis → Feature Engine → Probability Model → Confidence Layer → Report
```

| Spec skill | Implementation |
|---|---|
| Ticker Intelligence Collector | `lib/sec.ts`: ticker → CIK → legal entity (SEC `company_tickers_exchange.json` + submissions API), 8-K/6-K/tender-offer filings, Exhibit 99 press-release text |
| Catalyst Classifier | `lib/classify.ts`: Claude structured outputs (26-category taxonomy, novelty/materiality/surprise/credibility/certainty) with an anti-hallucination citation gate. A deterministic 8-K item rules engine is the fallback |
| Insider Signal | `lib/insider.ts`: Form 4 XML parsing. Only code-P open-market buys are weighted (CEO +12, CFO +10, cluster +8, …) |
| Market Context | `lib/market.ts`: stock vs sector ETF / SPY / QQQ, gap, RVOL, ATR, gap-vs-ATR |
| FDA connector | `lib/fda.ts`: openFDA Drugs@FDA approvals (biotech/healthcare only) |
| Breakout Context | User input: pattern `PEAK | CENTER | BOTTOM`, breakout date and D0 high |
| Scoring engine | `lib/scoring.ts`: Raw Score (10 components), a seed probability mapping, a separate confidence score, and the EV threshold `p* = (L + C) / (W + L)` |

Other behaviour:

- **Point-in-time:** no document published after `as_of` is used. Set *As of* in the UI to run a historical replay.
- **Conflicts:** when high-authority sources disagree, the probability is suppressed and the action becomes `WAIT_FOR_CONFIRMATION`.
- **No news:** the engine returns `NO_IDENTIFIABLE_NEWS` with possible drivers and low causal attribution.
- **Audit trail:** each report carries model, skill, scoring and calibration versions plus all source timestamps. You can download it as JSON.
- **Frontend:** a watchlist, threshold alerts and feedback labels (exportable for calibration), all stored in the browser.

## API

```
GET  /api/analyze?ticker=ABCD[&as_of=ISO][&pattern=PEAK&breakout_date=YYYY-MM-DD&breakout_high=12.34][&threshold=0.6]
POST /api/analyze  {"ticker":"ABCD","as_of":null,"breakout":{"pattern":"PEAK","breakout_date":"...","breakout_high":12.34},"threshold":0.6}
```

## Environment

| Var | Purpose |
|---|---|
| `SEC_USER_AGENT` | Required by SEC fair-access policy, e.g. `"M-Ticker Research ops@yourco.com"` |
| `ANTHROPIC_API_KEY` | Enables the Claude classifier. Without it, the rules engine is used |
| `CLAUDE_MODEL` | Optional override (default `claude-opus-5-5`) |
| `BLOB_READ_WRITE_TOKEN` | Private Vercel Blob store for saved Bull vs. Bear reports (set automatically when the store is connected; in-memory fallback otherwise) |

## Known limits (read before trading on it)

1. **Probabilities are not calibrated yet.** The mapping is a placeholder logistic curve labelled `seed-logistic@0`. Calibrate it with a point-in-time backtest: a pilot of 100–150 events, a calibration set of 300–500 events, and a validation set of 150–300. Judge the result with a Brier score and a calibration curve.
2. **Market data comes from Yahoo's public chart endpoint**, which is fine for development but not licensed for commercial use. Replace `fetchBars` in `lib/market.ts` with a licensed feed.
3. There is no licensed news feed yet. Official sources (SEC, FDA) are the source of truth.
4. Feedback and the watchlist live in browser storage. Add PostgreSQL before you need multi-user data.

## Bullish vs. Bearish research (`/research`)

The research page takes a ticker and builds a two-sided, evidence-backed report. Bearish arguments appear on the left and bullish ones on the right; on mobile they become two tabs, with Bullish selected first. It runs on its own or from a breakout report ("Bull vs. Bear research →"), and it never changes the breakout score.

| Skill | Module | Sources and window |
|---|---|---|
| 1. Company strategy | `lib/research/strategy.ts` | 8-K earnings and Reg FD releases (Exhibit 99) across 36 months. Claude compares each management commitment with later results. |
| 2. SEC filings | `lib/research/sec-financials.ts` | XBRL company facts covering revenue, quarterly YoY change and acceleration, margins, opex vs. revenue, net income, free cash flow, dilution, and debt vs. cash. Every figure links to its filing and period. |
| 3. News and social | `lib/research/news.ts` | Claude web search restricted to news sites, YouTube, X and Instagram, last 3 months. Only pages the search actually returned can be cited. Each provider's coverage is reported. |
| 4–5. Bull and bear analysts | `lib/research/analysts.ts` | Two independent Claude analysts read the same evidence. The bearish one is told to test the bull thesis rather than invent balance. |
| 6. Validator | `lib/research/validator.ts` | Deterministic code. It drops uncited claims, counts independent events rather than articles, scores strength from verification, corroboration and counter-evidence, merges duplicates, flags stale evidence, detects conflicts, and ranks arguments. |

**API**

```
POST /api/v1/intelligence/bull-bear/analyses       {"ticker":"NVDA","as_of":"…","options":{…}}  → 202 {analysis_id,status}
GET  /api/v1/intelligence/bull-bear/analyses/{id}  → full report (sources, evidence, arguments, conflicts, coverage, data_quality, audit)
GET  /api/v1/intelligence/bull-bear/analyses?ticker=NVDA → saved history
```

Analyses run in the background via `after()` and are stored in a private Vercel Blob store (`BLOB_READ_WRITE_TOKEN`), or in memory locally. Each report records the model, prompt version and pipeline version, plus publication and retrieval times for every source. Reports export as text, JSON or PDF (via print).

**Limitations:**
- Without `ANTHROPIC_API_KEY`, arguments come only from SEC financials, and the news and social channels show as unavailable.
- Earnings-call transcripts are licensed, so they are listed as missing.
- X and Instagram appear only as far as web search indexes them.
- Risk-factor text diffs are not automated yet.
- No probability is derived from the balance of arguments.

## CI/CD

```
push / PR ──► GitHub Actions CI ─────────── typecheck · unit tests · next build
          └─► Vercel (git integration) ──── npm test && next build ──► deploy
                                                  main → production, other branches/PRs → preview
                                                        │ deployment_status: success
                                                        ▼
                                  GitHub Actions smoke test (scripts/smoke.sh against the live URL)
```

- **CI** (`.github/workflows/ci.yml`) runs on every push and pull request: `npm run typecheck`, `vitest`, `next build`. JUnit results are uploaded as an artifact.
- **CD** is handled by Vercel's GitHub integration on the `my-ticker` project. A push to `main` deploys to production, and any other branch or PR gets a preview URL. `vercel.json` runs `npm test` before the build, so a failing test blocks the deploy.
- **Smoke test** (`.github/workflows/smoke.yml`) runs after each successful Vercel deployment. It loads the page and calls `/api/analyze?ticker=AAPL` against the real deployment. While Vercel Authentication protects the site, add a `VERCEL_AUTOMATION_BYPASS_SECRET` repo secret (from Vercel → Settings → Deployment Protection → Protection Bypass for Automation). Without it the smoke test skips with a warning.

## Tests

```bash
npm test          # vitest, ~0.5s, no network
npm run ci        # typecheck + tests + build, same as CI
```

The unit tests cover EDGAR timestamp handling, point-in-time filing filters, Form 4 XML parsing (from a fixture), insider scoring, the rules classifier, the raw score, seed probability and confidence, the EV threshold, sector mapping, HTML extraction, i18n key parity, and the API route (with the pipeline mocked).

## Develop

```bash
npm install
cp .env.example .env.local
npm run dev
```
