import { writeFileSync, mkdirSync } from "fs"
import { SUPABASE_URL, SUPABASE_HEADERS } from "./shared"

// Weekly (and daily for events): a small copy of the most useful part of the index, for when the
// database can't answer. The 5,000 best-known sites (name, category, city, one-line summary) and the
// next 4 days of events, in data/fallback.json in this (public) repo. actuent-public copies it into
// its own deploy (scripts/copy_fallback.mjs) and reads it straight from here as a second source, so
// a search still gets an answer when Supabase is down, full or read-only. Nothing private is in it.

const SITES = parseInt(process.env.FALLBACK_SITES || "5000")
const clip = (s: unknown, n: number) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1).replace(/\s+\S*$/, "")}…` : t }

async function get(path: string): Promise<any[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: SUPABASE_HEADERS, signal: AbortSignal.timeout(60000) })
  if (!r.ok) throw new Error(`${path.split("?")[0]}: ${r.status} ${await r.text()}`)
  return r.json()
}

async function main() {
  const sites: any[] = []
  for (let from = 0; from < SITES; from += 1000) {
    const rows = await get(`lawp_sites?select=domain,name,category,pages->/,business->address->>city,popularity_rank&status=is.null&popularity_rank=not.is.null&order=popularity_rank.asc&limit=${Math.min(1000, SITES - from)}&offset=${from}`)
    sites.push(...rows)
    if (rows.length < 1000) break
  }
  const now = new Date(), until = new Date(Date.now() + 4 * 86400000)
  const events: any[] = []
  for (let from = 0; from < 6000; from += 1000) {
    const rows = await get(`lawp_events?select=name,url,domain,start_date,venue,city,country,price,currency,description&start_date=gte.${encodeURIComponent(new Date(Date.now() - 6 * 3600000).toISOString())}&start_date=lt.${encodeURIComponent(until.toISOString())}&city=not.is.null&order=start_date.asc&limit=1000&offset=${from}`)
    events.push(...rows)
    if (rows.length < 1000) break
  }
  const data = {
    built_at: now.toISOString(),
    sites: sites.map(s => {
      const home = s["/"] || s.pages || {}
      return [s.domain, clip(s.name, 60), s.category || "", s.city || "", clip(home.content || home.title || "", 160)]
    }),
    events: events.map(e => [clip(e.name, 90), e.url, e.start_date, clip(e.venue, 60), e.city, e.country || "", e.price ?? null, e.currency || "", clip(String(e.description || "").split(/[.!?]/)[0], 50)])
  }
  mkdirSync("data", { recursive: true })
  const json = JSON.stringify(data)
  writeFileSync("data/fallback.json", json)
  console.log(`${data.sites.length} sites, ${data.events.length} events, ${Math.round(json.length / 1024)} KB`)
}

main().catch(e => { console.error(e); process.exit(1) })
