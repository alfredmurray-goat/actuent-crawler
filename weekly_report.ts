import { SUPABASE_URL, SUPABASE_HEADERS } from "./shared"

// Weekly "State of the AI web" post, every Monday: how much of the web AI agents can read and act
// on, what changed since last week, what agents searched for. Numbers from the index; the text is
// written from a template (no LLM), so every figure in it is exact. Saved to weekly_reports
// (list_eight.sql) and published at api.actuent.ai/state/weekly/<date>, with an RSS feed.
// Aggregates only: queries shown are plain words searched at least 3 times, never URLs or emails.

if (!process.env.SUPABASE_SERVICE_KEY) { console.error("Missing SUPABASE_SERVICE_KEY"); process.exit(1) }

const CATEGORY_NAMES: Record<string, string> = {
  restaurant: "Restaurants", cafe: "Cafés", bar: "Bars", bakery: "Bakeries", hotel: "Hotels", travel: "Travel", events: "Events & venues",
  museum_culture: "Museums & culture", hair_beauty: "Hair & beauty", spa_wellness: "Spa & wellness", fitness: "Fitness", dental: "Dentists",
  health: "Health", shop_fashion: "Fashion shops", shop_beauty: "Beauty shops", shop_electronics: "Electronics shops", shop_home: "Home shops",
  shop_sports: "Sports shops", shop_kids: "Kids' shops", shop_grocery: "Grocery shops", shop: "Shops", pets: "Pets", food_delivery: "Food delivery",
  ai: "AI", developer: "Developer tools", software: "Software", news_media: "News & media", education: "Education", finance: "Finance",
  real_estate: "Real estate", legal: "Legal", automotive: "Automotive", home_services: "Home services", jobs: "Jobs", nonprofit: "Non-profits", social: "Social"
}

async function count(table: string, filter = ""): Promise<number | null> {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*${filter ? `&${filter}` : ""}`, {
      method: "HEAD", headers: { ...SUPABASE_HEADERS, "Prefer": "count=exact", "Range": "0-0" }
    })
    const total = r.headers.get("content-range")?.split("/")[1]
    return total && total !== "*" ? Number(total) : null
  } catch { return null }
}

const pct = (a: number | null, b: number | null) => a != null && b ? Math.round((a / b) * 1000) / 10 : null
const fmt = (n: number | null | undefined) => n == null ? "—" : n.toLocaleString("en-GB")
function delta(now: number | null, before: number | null | undefined, unit = ""): string {
  if (now == null || before == null) return ""
  const d = Math.round((now - before) * 10) / 10
  return d === 0 ? " (no change)" : ` (${d > 0 ? "+" : "−"}${fmt(Math.abs(d))}${unit} on last week)`
}

async function main() {
  // The Monday this report covers the week up to.
  const today = new Date(); today.setUTCHours(0, 0, 0, 0)
  const week = today.toISOString().slice(0, 10)
  const since = encodeURIComponent(new Date(today.getTime() - 7 * 86400000).toISOString())
  const now = encodeURIComponent(new Date().toISOString())

  const [sites, readable, native, minimal, withBusiness, withHours, checkedAccess, blockingAi, products, pages, upcomingEvents, newSites, searches] = await Promise.all([
    count("lawp_sites", "status=is.null"),
    count("lawp_sites", "status=is.null&actions=neq.%5B%5D"),
    count("lawp_sites", "native=eq.true"),
    count("lawp_sites", "status=is.null&actions=eq.%5B%5D"),
    count("lawp_sites", "business=not.is.null"),
    count("lawp_sites", "business->opening_hours=not.is.null"),
    count("lawp_sites", "ai_access=not.is.null"),
    count("lawp_sites", "ai_access=not.is.null&ai_access->blocked=neq.%5B%5D"),
    count("lawp_items"),
    count("lawp_pages"),
    count("lawp_events", `start_date=gte.${now}`),
    count("lawp_sites", `first_seen_at=gte.${since}`),
    count("searches", `created_at=gte.${since}`)
  ])

  const categories = (await Promise.all(Object.keys(CATEGORY_NAMES).map(async c => ({ category: c, sites: await count("lawp_sites", `category=eq.${c}&status=is.null&actions=neq.%5B%5D`) || 0 }))))
    .filter(c => c.sites > 0).sort((a, b) => b.sites - a.sites)

  // Cities: from the city directory function (sites with a published address).
  const cityRows: any[] = await fetch(`${SUPABASE_URL}/rest/v1/rpc/lawp_city_categories?min_sites=1`, { headers: SUPABASE_HEADERS }).then(r => r.ok ? r.json() : []).catch(() => [])
  const cityTotals = new Map<string, number>()
  for (const r of cityRows) if (r.city && !["adult", "gambling"].includes(r.category)) cityTotals.set(r.city, (cityTotals.get(r.city) || 0) + Number(r.sites))
  const cities = [...cityTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([city, n]) => ({ city, sites: n }))

  let topQueries: { query: string, searches: number }[] = []
  let topSites: { domain: string, appearances: number }[] = []
  const languages: Record<string, number> = {}
  {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/searches?select=query,domains&created_at=gte.${since}&order=created_at.desc&limit=20000`, { headers: SUPABASE_HEADERS })
    const rows: any[] = r.ok ? await r.json() : []
    const q: Record<string, number> = {}, d: Record<string, number> = {}
    for (const row of rows) {
      const query = String(row.query || "").toLowerCase().trim()
      if (query && query.length <= 40 && !/[@/:]|\d{4,}|\.[a-z]{2,}$|^\[object /.test(query)) q[query] = (q[query] || 0) + 1
      for (const domain of (row.domains || []).slice(0, 5)) d[domain] = (d[domain] || 0) + 1
    }
    topQueries = Object.entries(q).filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([query, searches]) => ({ query, searches }))
    topSites = Object.entries(d).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([domain, appearances]) => ({ domain, appearances }))
  }
  for (const l of ["en", "de", "fr", "es", "nl", "it", "pt", "da", "sv", "ja"]) languages[l] = await count("lawp_sites", `language=eq.${l}&status=is.null`) || 0

  // Click-through: visits Actuent sent to sites (api.actuent.ai/go links) per search this week.
  const clickRows: any[] = await fetch(`${SUPABASE_URL}/rest/v1/link_clicks?select=clicks&day=gte.${new Date(today.getTime() - 7 * 86400000).toISOString().slice(0, 10)}&limit=10000`, { headers: SUPABASE_HEADERS }).then(r => r.ok ? r.json() : []).catch(() => [])
  const visitsSent = clickRows.reduce((n, r) => n + (Number(r.clicks) || 0), 0)

  const previous = await fetch(`${SUPABASE_URL}/rest/v1/weekly_reports?select=data&week=lt.${week}&order=week.desc&limit=1`, { headers: SUPABASE_HEADERS })
    .then(r => r.ok ? r.json() : []).then(rows => rows?.[0]?.data || null).catch(() => null)

  const data = {
    week, sites, readable, readable_percent: pct(readable, sites), native, minimal, with_business: withBusiness, with_hours: withHours,
    ai_access_checked: checkedAccess, blocking_ai: blockingAi, blocking_ai_percent: pct(blockingAi, checkedAccess),
    products, pages, upcoming_events: upcomingEvents, new_sites: newSites, searches,
    visits_sent: visitsSent, click_through_percent: searches ? Math.round(visitsSent / searches * 1000) / 10 : null,
    categories: categories.slice(0, 12), cities, top_queries: topQueries, top_sites: topSites, languages
  }

  const p = previous || {}
  const lines = [
    `Actuent now indexes ${fmt(sites)} websites${delta(sites, p.sites)}. ${fmt(readable)} of them (${data.readable_percent ?? "—"}%) are readable by AI agents, with pages and actions an agent can use${delta(data.readable_percent, p.readable_percent, " points")}.`,
    `${fmt(native)} site${native === 1 ? "" : "s"} publish their own LAWP file${delta(native, p.native)}, which lets agents take actions on them directly.`,
    checkedAccess ? `Of ${fmt(checkedAccess)} sites whose robots.txt was checked, ${data.blocking_ai_percent ?? "—"}% block at least one AI bot${delta(data.blocking_ai_percent, p.blocking_ai_percent, " points")}.` : "",
    `Agents can find ${fmt(products)} products with prices, ${fmt(pages)} indexed pages, ${fmt(upcomingEvents)} upcoming events and ${fmt(withBusiness)} businesses with an address${withHours ? ` (${fmt(withHours)} with opening hours)` : ""}.`,
    searches ? `Agents ran ${fmt(searches)} searches this week${delta(searches, p.searches)} and sent ${fmt(visitsSent)} visits to websites.` : ""
  ].filter(Boolean)
  const title = `State of the AI web — week of ${new Date(week + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })}`
  const summary = lines.join(" ")

  const r = await fetch(`${SUPABASE_URL}/rest/v1/weekly_reports?on_conflict=week`, {
    method: "POST", headers: { ...SUPABASE_HEADERS, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates" },
    body: JSON.stringify({ week, title, summary, data, created_at: new Date().toISOString() })
  })
  if (!r.ok) throw new Error(`Could not save the report: ${r.status} ${await r.text()}`)
  console.log(`${title}\n\n${summary}`)
}

main().catch(e => { console.error(e); process.exit(1) })
