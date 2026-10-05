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
  const ms = Date.now() - t
  // The other parts people and agents use: a site page, autocomplete and a badge (list_twentyfour.sql).
  const time = async (url: string) => { const t0 = Date.now(); const x = await fetch(url, { headers: { "User-Agent": "Actuent-Smoke/1.0 (status)" }, signal: AbortSignal.timeout(20000) }).catch(() => null); if (x) await x.arrayBuffer().catch(() => null); return x?.ok ? Date.now() - t0 : null }
  const [site_ms, autocomplete_ms, badge_ms] = await Promise.all([time(`https://api.actuent.ai/site/nike.com?_=${t}`), time(`https://api.actuent.ai/api/autocomplete?q=nik&_=${t}`), time(`https://api.actuent.ai/badge.svg?domain=nike.com&_=${t}`)])
  const post = (row: object) => fetch(`${SUPABASE_URL}/rest/v1/uptime_checks`, { method: "POST", headers: { ...SUPABASE_HEADERS, "Content-Type": "application/json", "Prefer": "return=minimal" }, body: JSON.stringify(row) }).catch(() => null)
  const saved = await post({ ok, ms, site_ms, autocomplete_ms, badge_ms })
  if (!saved?.ok) await post({ ok, ms })
  console.log(`Status check: search ${ok ? "answered" : "did NOT answer"} in ${ms} ms; site page ${site_ms} ms, autocomplete ${autocomplete_ms} ms, badge ${badge_ms} ms`)
}

// The shared allowance for signed-out Claude.ai/ChatGPT users (actuent-private api/mcp.ts) more than
// 75% used, or full, in the last hour: fail so GitHub emails Alfred (raise it in mcp.ts if it's real use).
async function platformLimits() {
  const since = encodeURIComponent(new Date(Date.now() - 3600_000).toISOString())
  const r = await fetch(`${SUPABASE_URL}/rest/v1/usage_counters?select=key,count&key=like.platform_*&window_start=gte.${since}`, { headers: SUPABASE_HEADERS }).catch(() => null)
  for (const row of r?.ok ? await r.json() : []) {
    const [kind, platform] = String(row.key).replace(/^platform_/, "").split(":")
    console.log(`::error::${platform === "anthropic" ? "Claude.ai" : "ChatGPT"} users ${kind === "full" ? "hit" : "came close to"} Actuent's shared limit (600 tool calls a minute) ${row.count} times in the last hour. If this is real use, raise the platform limit in actuent-private api/mcp.ts.`)
    process.exitCode = 1
  }
}

async function main() {
  await recordUptime()
  await platformLimits()
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
