import { SUPABASE_URL, SUPABASE_HEADERS } from "./shared"
import { markSearchSlow } from "./quiet"

// Hourly: how fast searches were in the last hour. When the slowest 5% took over 3 seconds (with
// at least 20 searches), this job fails — and GitHub emails the repository owner about it.

if (!process.env.SUPABASE_SERVICE_KEY) { console.error("Missing SUPABASE_SERVICE_KEY"); process.exit(1) }
const LIMIT_MS = parseInt(process.env.P95_LIMIT_MS || "3000")

// Status history (api.actuent.ai/status): does search answer right now, and how fast? One row an hour
// in uptime_checks (list_nineteen.sql). "Actuent-Smoke" searches are logged as tests, not real ones.
async function recordUptime() {
  const t = Date.now()
  const r = await fetch("https://api.actuent.ai/api/search?q=nike&_=" + t, { headers: { "User-Agent": "Actuent-Smoke/1.0 (status)" }, signal: AbortSignal.timeout(20000) }).catch(() => null)
  const body = r?.ok ? await r.json().catch(() => null) : null
  const ok = !!body && Array.isArray(body.results) && body.results.length > 0
  await fetch(`${SUPABASE_URL}/rest/v1/uptime_checks`, { method: "POST", headers: { ...SUPABASE_HEADERS, "Content-Type": "application/json", "Prefer": "return=minimal" }, body: JSON.stringify({ ok, ms: Date.now() - t }) }).catch(() => {})
  console.log(`Status check: search ${ok ? "answered" : "did NOT answer"} in ${Date.now() - t} ms`)
}

async function main() {
  await recordUptime()
  const since = encodeURIComponent(new Date(Date.now() - 3600_000).toISOString())
  const r = await fetch(`${SUPABASE_URL}/rest/v1/searches?select=duration_ms&created_at=gte.${since}&duration_ms=not.is.null&limit=10000`, { headers: SUPABASE_HEADERS })
  const times = (r.ok ? await r.json() : []).map((x: any) => Number(x.duration_ms)).sort((a: number, b: number) => a - b)
  if (times.length < 20) { console.log(`${times.length} timed searches in the last hour: too few to judge`); return }
  const p50 = times[Math.floor(times.length * 0.5)], p95 = times[Math.floor(times.length * 0.95)]
  console.log(`Last hour: ${times.length} searches, median ${p50} ms, slowest 5% ${p95} ms`)
  if (p95 > LIMIT_MS) {
    console.log(`::error::Search is slow: the slowest 5% took ${p95} ms in the last hour (limit ${LIMIT_MS} ms). Check the ops page and Supabase.`)
    // Heavy jobs (quiet.ts) stop for the next 45 minutes so search gets the database back.
    await markSearchSlow(45)
    process.exitCode = 1
  }
}

main().catch(e => { console.error(e); process.exit(1) })
