#!/usr/bin/env bash
# Smoke-test a deployed M-Ticker instance: home page renders, API returns a report.
# Usage: scripts/smoke.sh https://my-ticker.vercel.app   (BYPASS env optional)
set -euo pipefail
BASE="${1:?base URL required}"
BASE="${BASE%/}"
HDR=()
if [[ -n "${BYPASS:-}" ]]; then HDR=(-H "x-vercel-protection-bypass: ${BYPASS}"); fi

code=$(curl -sS -o /tmp/home.html -w '%{http_code}' "${HDR[@]}" "$BASE/")
if [[ "$code" == "401" || "$code" == "403" ]] && [[ -z "${BYPASS:-}" ]]; then
  echo "::warning::$BASE is protected by Vercel Authentication (HTTP $code). Add the VERCEL_AUTOMATION_BYPASS_SECRET repo secret to run smoke tests. Skipping."
  exit 0
fi
[[ "$code" == "200" ]] || { echo "::error::Home page returned HTTP $code"; exit 1; }
grep -q "M-Ticker" /tmp/home.html || { echo "::error::Home page did not render the app"; exit 1; }
echo "✓ home page"

code=$(curl -sS -o /tmp/api.json -w '%{http_code}' --max-time 90 "${HDR[@]}" "$BASE/api/analyze?ticker=AAPL")
[[ "$code" == "200" ]] || { echo "::error::/api/analyze returned HTTP $code: $(head -c 300 /tmp/api.json)"; exit 1; }
node -e '
  const r = JSON.parse(require("fs").readFileSync("/tmp/api.json", "utf8"));
  const fail = (m) => { console.log("::error::" + m); process.exit(1); };
  if (r.ticker !== "AAPL") fail("unexpected ticker " + r.ticker);
  if (r.entity?.cik !== "0000320193") fail("entity resolution failed");
  if (!Array.isArray(r.filings) || r.filings.length === 0) fail("no SEC filings returned");
  if (!r.market_context?.available) console.log("::warning::market data unavailable: " + r.market_context?.error);
  if (r.insider?.form4_count > 0 && r.insider.transactions.length === 0) fail("Form 4 parsing returned no transactions");
  console.log(`✓ api: ${r.primary_catalyst.category}, P=${r.probability_no_averaging}, confidence=${r.confidence}, ${r.audit.run_ms}ms`);
'
