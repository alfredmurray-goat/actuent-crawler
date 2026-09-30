import { SUPABASE_URL, SUPABASE_HEADERS } from "./shared"

// Every 2 hours: runs the most common searches straight against the database search functions, so the
// parts of the search index they need stay in memory. The free database can't keep the whole index
// in memory, and a search's first run in a while takes ~5 s; after this, people get the fast run.
// Also logs how long the database took, which shows whether the database is the slow part.

if (!process.env.SUPABASE_SERVICE_KEY) { console.error("Missing SUPABASE_SERVICE_KEY"); process.exit(1) }
const LIMIT = parseInt(process.env.WARM_INDEX_LIMIT || "80")
const JSON_HEADERS = { ...SUPABASE_HEADERS, "Content-Type": "application/json" }

// Always warm, even before anyone has searched them this week.
const STAPLES = ["running shoes", "sneakers", "headphones", "laptop", "project management software", "accounting software", "crm software",
  "email marketing", "website builder", "online store platform", "password manager", "video conferencing", "note taking app", "cloud hosting",
  "vpn", "cheap flights", "hotel booking", "car rental", "concert tickets", "food delivery", "recipes", "language learning app", "online courses",
  "restaurant", "coffee", "barber", "dentist", "hotel", "museum", "pizza", "bakery", "gym"]

async function topSearches(): Promise<string[]> {
  // Counted in the database (search_trends, list_eighteen.sql) instead of downloading the search log.
  const t = await fetch(`${SUPABASE_URL}/rest/v1/rpc/search_trends`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ since: new Date(Date.now() - 7 * 86400000).toISOString(), min_count: 1, max_rows: 150 }) }).catch(() => null)
  if (t?.ok) { const rows: any[] = await t.json(); if (rows.length) return rows.map(r => String(r.query)).filter(q => !/^\S+\.[a-z]{2,}$/.test(q) && q.split(/\s+/).length <= 8) }
  const since = encodeURIComponent(new Date(Date.now() - 7 * 86400000).toISOString())
  const r = await fetch(`${SUPABASE_URL}/rest/v1/searches?select=query&created_at=gte.${since}&order=created_at.desc&limit=20000`, { headers: SUPABASE_HEADERS }).catch(() => null)
  const rows: any[] = r?.ok ? await r.json() : []
  const counts = new Map<string, number>()
  for (const { query } of rows) {
    const q = String(query || "").toLowerCase().trim()
    // Plain keyword searches only: no domains, no personal details.
    if (!q || q.length > 60 || /[@/:]|\d{4,}|^\[object |^\S+\.[a-z]{2,}$/.test(q) || q.split(/\s+/).length > 8) continue
    counts.set(q, (counts.get(q) || 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([q]) => q)
}

async function timed(fn: string, q: string): Promise<number> {
  const t = Date.now()
  await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ q, max_results: 50 }), signal: AbortSignal.timeout(20000) })
    .then(r => r.arrayBuffer()).catch(() => null)
  return Date.now() - t
}

async function main() {
  const start = Date.now()
  // When searches were slow in the last hour (speed_alert.ts), warming would only add load: skip.
  const flag = await fetch(`${SUPABASE_URL}/rest/v1/crawler_state?id=eq.search_slow_until&select=value`, { headers: SUPABASE_HEADERS }).then(r => r.ok ? r.json() : []).catch(() => [])
  if ((Number(flag?.[0]?.value) || 0) * 60_000 > Date.now()) { console.log("Searches are slow right now: skipping the warm-up this time."); return }
  const queries = [...new Set([...(await topSearches()), ...STAPLES])].slice(0, LIMIT)
  // First choice: the warm-up runs on Supabase, next to the database (api.actuent.ai/api/warm).
  const edge = await fetch("https://api.actuent.ai/api/warm", { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "Actuent-Warm/1.0" }, body: JSON.stringify({ queries }), signal: AbortSignal.timeout(140000) }).catch(() => null)
  if (edge?.ok) { const d = await edge.json(); console.log(`Warmed ${d.warmed} searches next to the database in ${d.seconds} s. Database time per search: median ${d.median_ms} ms, slowest 5% ${d.p95_ms} ms.`); return }
  console.log(`Warm-up next to the database didn't answer (${edge?.status ?? "no answer"}): warming from here instead.`)
  const times: number[] = []
  let index = 0
  // Two at a time: enough to finish in a few minutes, not so many that it slows real searches.
  await Promise.all([0, 1].map(async () => {
    while (index < queries.length) {
      const q = queries[index++]
      const [a, b] = await Promise.all([timed("search_lawp_sites", q), timed("search_lawp_pages", q)])
      times.push(Math.max(a, b))
    }
  }))
  times.sort((a, b) => a - b)
  const pct = (p: number) => times[Math.min(times.length - 1, Math.floor(times.length * p))] || 0
  console.log(`Warmed ${queries.length} searches in ${Math.round((Date.now() - start) / 1000)} s. Database time per search: median ${pct(0.5)} ms, slowest 5% ${pct(0.95)} ms.`)
}

main().catch(e => { console.error(e); process.exit(1) })
