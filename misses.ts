import { SUPABASE_URL, SUPABASE_HEADERS } from "./shared"
import { promises as dns } from "dns"

// Weekly: searches that went wrong last week — nothing found, nothing opened, or rewritten straight
// away — and, for each, the site people probably meant: <name>.com/.io/… when it exists, else
// Wikidata's official website for the name. Those sites are queued for crawling (crawl_queue.ts
// adds them within the hour), and everything is recorded in search_misses for the ops page.

if (!process.env.SUPABASE_SERVICE_KEY) { console.error("Missing SUPABASE_SERVICE_KEY"); process.exit(1) }
const JSON_HEADERS = { ...SUPABASE_HEADERS, "Content-Type": "application/json" }
const week = encodeURIComponent(new Date(Date.now() - 7 * 86400000).toISOString())
const plain = (q: string) => q && q.length <= 60 && !/[@/:]|\d{4,}|^\[object /.test(q)

async function rows(path: string): Promise<any[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: SUPABASE_HEADERS }).catch(() => null)
  return r?.ok ? await r.json() : []
}
function tally(list: any[]): [string, number][] {
  const m = new Map<string, number>()
  for (const r of list) { const q = String(r.query || "").toLowerCase().trim(); if (plain(q)) m.set(q, (m.get(q) || 0) + 1) }
  return [...m.entries()].sort((a, b) => b[1] - a[1])
}

async function exists(domain: string): Promise<boolean> {
  try { await dns.lookup(domain); return true } catch { return false }
}

async function guessSite(q: string): Promise<string | null> {
  const words = q.replace(/\b(tickets?|near me|online|official|website|app|login|prices?|opening hours)\b/g, " ").replace(/\s+/g, " ").trim()
  if (!words || words.split(" ").length > 3) return null
  const label = words.replace(/[\s'&.]+/g, "")
  for (const tld of ["com", "io", "ai", "co", "app", "dk", "net", "org"]) {
    const d = `${label}.${tld}`
    if (await exists(d)) {
      const known = await rows(`lawp_sites?select=domain&domain=eq.${d}`)
      if (!known.length) return d
      return null // already indexed: the search itself needs fixing, not the index
    }
  }
  try {
    const ua = { "User-Agent": "Actuent/1.0 (+https://docs.actuent.ai/bot; support@localilabs.com)" }
    const found = await fetch(`https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(words)}&language=en&type=item&limit=1&format=json`, { headers: ua }).then(r => r.json())
    const id = found?.search?.[0]?.id
    if (!id) return null
    const ent = await fetch(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${id}&props=claims&format=json`, { headers: ua }).then(r => r.json())
    const url = ent?.entities?.[id]?.claims?.P856?.[0]?.mainsnak?.datavalue?.value
    return typeof url === "string" ? new URL(url).hostname.replace(/^www\./, "") : null
  } catch { return null }
}

async function main() {
  const [zero, recent, rewritten] = await Promise.all([
    rows(`searches?select=query&result_count=eq.0&created_at=gte.${week}&limit=5000`),
    rows(`searches?select=query&created_at=gte.${week}&order=created_at.desc&limit=5000`),
    rows(`query_reformulations?select=from_query,times&updated_at=gte.${week}&times=gte.2&order=times.desc&limit=50`)
  ])
  const popular = tally(recent).filter(([, n]) => n >= 5).slice(0, 80)
  const clicked = new Set<string>()
  if (popular.length) {
    const list = encodeURIComponent(popular.map(([q]) => `"${q.replace(/"/g, "")}"`).join(","))
    for (const r of await rows(`query_clicks?select=query&query=in.(${list})`)) clicked.add(r.query)
  }
  const misses: { query: string, kind: string, searches: number }[] = [
    ...tally(zero).slice(0, 50).map(([query, searches]) => ({ query, kind: "zero_results", searches })),
    ...popular.filter(([q]) => !clicked.has(q)).slice(0, 30).map(([query, searches]) => ({ query, kind: "no_clicks", searches })),
    ...rewritten.filter((r: any) => plain(r.from_query)).map((r: any) => ({ query: r.from_query, kind: "reformulated", searches: r.times }))
  ]
  let queued = 0
  for (const m of misses) {
    const site = await guessSite(m.query)
    if (site) {
      await fetch(`${SUPABASE_URL}/rest/v1/rpc/queue_crawl`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ d: site }) }).catch(() => {})
      queued++
    }
    await fetch(`${SUPABASE_URL}/rest/v1/search_misses?on_conflict=query`, {
      method: "POST", headers: { ...JSON_HEADERS, "Prefer": "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ ...m, suggestion: site, checked_at: new Date().toISOString() })
    }).catch(() => {})
    console.log(`${m.kind.padEnd(13)} ${String(m.searches).padStart(4)}× ${m.query}${site ? `  → queued ${site}` : ""}`)
  }
  console.log(`${misses.length} searches to improve, ${queued} sites queued for crawling`)
}

main().catch(e => { console.error(e); process.exit(1) })
