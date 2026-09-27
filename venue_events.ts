
// Weekly: re-reads the events pages of every venue in the index (theatres, cinemas, music venues,
// arts centres, clubs, museums…), so actuent_events and "what's on" pages stay current. Venues are
// found by their business type (schema.org or OpenStreetMap). Writes only lawp_events.

const TIME_BUDGET_MS = parseInt(process.env.TIME_BUDGET_MIN || "100") * 60000
const CONCURRENCY = 6
const TYPES = ["theatre", "cinema", "arts centre", "music venue", "nightclub", "concert hall", "events venue", "community centre", "stadium", "museum", "gallery", "comedy club",
  "jazz club", "MovieTheater", "PerformingArtsTheater", "MusicVenue", "EventVenue", "NightClub", "Museum", "StadiumOrArena", "ComedyClub", "TheaterGroup", "Festival"]
if (!process.env.SUPABASE_SERVICE_KEY) { console.error("Missing SUPABASE_SERVICE_KEY"); process.exit(1) }

async function main() {
  // Imported here so osm_businesses.ts doesn't start its own run.
  process.env.OSM_NO_MAIN = "1"
  const { venueEvents } = await import("./osm_businesses")
  const { SUPABASE_URL, SUPABASE_HEADERS } = await import("./shared")
  const started = Date.now()
  const list = encodeURIComponent(TYPES.map(t => `"${t}"`).join(","))
  const domains: string[] = []
  let last = ""
  for (;;) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?select=domain&business->>type=in.(${list})&status=is.null&domain=gt.${encodeURIComponent(last)}&order=domain.asc&limit=1000`, { headers: SUPABASE_HEADERS })
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`)
    const rows: { domain: string }[] = await r.json()
    if (!rows.length) break
    domains.push(...rows.map(x => x.domain))
    last = rows[rows.length - 1].domain
  }
  console.log(`${domains.length} venues`)
  let events = 0, done = 0
  async function worker() {
    while (domains.length && Date.now() - started < TIME_BUDGET_MS) {
      const d = domains.shift()!
      try { events += await venueEvents(d) } catch {}
      done++
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  console.log(`${done} venues read, ${events} events saved`)
}

main().catch(e => { console.error(e); process.exit(1) })
