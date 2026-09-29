import { SUPABASE_URL, SUPABASE_HEADERS, fetchSite, saveSite, saveEvents, robotsAllows } from "./shared"
import { searchNeedsTheDatabase } from "./quiet"
import { heuristicLAWP, withBookingLinks } from "./heuristic"
import { extractBusiness, extractEvents, Business, OpeningHours } from "./business"
import { rescue } from "./rescue"
import { cleanPages } from "./boilerplate"
import { fetchPublic, isPublicHost } from "./safe-fetch"
import { USER_AGENT } from "./robots"

// Local businesses from OpenStreetMap. The Tranco list is big websites; the barber, dentist and
// bakery down the road are in OSM, often with their website. For one city per step (rotating through
// CITIES), this finds shops, restaurants, clinics, offices and venues that list a website, then:
//   • new websites are crawled with the rule-based converter (no LLM, so it never takes quota from
//     the other jobs) and saved with OSM's address, phone, opening hours and location as business
//     details, so actuent_nearby and "open now" work even when the site has no schema.org data;
//   • already-indexed sites without business details get OSM's (only the business column is written);
//   • venues (theatres, cinemas, music venues, arts centres…) have their events pages read (#5).
// Chain branches (a website path under a brand's domain) are skipped. OSM data is ODbL: the site
// pages credit "© OpenStreetMap contributors".

const OVERPASS = process.env.OVERPASS_URL || "https://overpass-api.de/api/interpreter"
// Overpass asks for an identifying agent with contact details (browser-like agents get 406).
const OSM_AGENT = "Actuent/1.0 (+https://docs.actuent.ai/bot; support@localilabs.com)"
const TIME_BUDGET_MS = parseInt(process.env.TIME_BUDGET_MIN || "100") * 60000
const CITIES_PER_RUN = parseInt(process.env.CITIES_PER_RUN || "4")
const RADIUS_M = parseInt(process.env.RADIUS_M || "7000")
const CONCURRENCY = parseInt(process.env.CONCURRENCY || "8")
const started = Date.now()

// [name, lat, lon, ISO country]
const CITIES: [string, number, number, string][] = [
  ["Copenhagen", 55.6761, 12.5683, "dk"], ["Aarhus", 56.1629, 10.2039, "dk"], ["Odense", 55.4038, 10.4024, "dk"], ["Stockholm", 59.3293, 18.0686, "se"],
  ["Gothenburg", 57.7089, 11.9746, "se"], ["Malmö", 55.605, 13.0038, "se"], ["Oslo", 59.9139, 10.7522, "no"], ["Bergen", 60.3913, 5.3221, "no"],
  ["Helsinki", 60.1699, 24.9384, "fi"], ["London", 51.5072, -0.1276, "gb"], ["Manchester", 53.4808, -2.2426, "gb"], ["Birmingham", 52.4862, -1.8904, "gb"],
  ["Leeds", 53.8008, -1.5491, "gb"], ["Glasgow", 55.8642, -4.2518, "gb"], ["Edinburgh", 55.9533, -3.1883, "gb"], ["Bristol", 51.4545, -2.5879, "gb"],
  ["Liverpool", 53.4084, -2.9916, "gb"], ["Dublin", 53.3498, -6.2603, "ie"], ["Amsterdam", 52.3676, 4.9041, "nl"], ["Rotterdam", 51.9244, 4.4777, "nl"],
  ["Utrecht", 52.0907, 5.1214, "nl"], ["Brussels", 50.8503, 4.3517, "be"], ["Antwerp", 51.2194, 4.4025, "be"], ["Berlin", 52.52, 13.405, "de"],
  ["Hamburg", 53.5511, 9.9937, "de"], ["Munich", 48.1351, 11.582, "de"], ["Cologne", 50.9375, 6.9603, "de"], ["Frankfurt", 50.1109, 8.6821, "de"],
  ["Vienna", 48.2082, 16.3738, "at"], ["Zurich", 47.3769, 8.5417, "ch"], ["Geneva", 46.2044, 6.1432, "ch"], ["Paris", 48.8566, 2.3522, "fr"],
  ["Lyon", 45.764, 4.8357, "fr"], ["Marseille", 43.2965, 5.3698, "fr"], ["Madrid", 40.4168, -3.7038, "es"], ["Barcelona", 41.3874, 2.1686, "es"],
  ["Valencia", 39.4699, -0.3763, "es"], ["Lisbon", 38.7223, -9.1393, "pt"], ["Porto", 41.1579, -8.6291, "pt"], ["Rome", 41.9028, 12.4964, "it"],
  ["Milan", 45.4642, 9.19, "it"], ["Florence", 43.7696, 11.2558, "it"], ["Prague", 50.0755, 14.4378, "cz"], ["Warsaw", 52.2297, 21.0122, "pl"],
  ["Krakow", 50.0647, 19.945, "pl"], ["Budapest", 47.4979, 19.0402, "hu"], ["Athens", 37.9838, 23.7275, "gr"], ["Reykjavik", 64.1466, -21.9426, "is"],
  ["New York", 40.7128, -74.006, "us"], ["Brooklyn", 40.6782, -73.9442, "us"], ["Los Angeles", 34.0522, -118.2437, "us"], ["San Francisco", 37.7749, -122.4194, "us"],
  ["Chicago", 41.8781, -87.6298, "us"], ["Boston", 42.3601, -71.0589, "us"], ["Seattle", 47.6062, -122.3321, "us"], ["Austin", 30.2672, -97.7431, "us"],
  ["Denver", 39.7392, -104.9903, "us"], ["Portland", 45.5152, -122.6784, "us"], ["Washington", 38.9072, -77.0369, "us"], ["Miami", 25.7617, -80.1918, "us"],
  ["Toronto", 43.6532, -79.3832, "ca"], ["Vancouver", 49.2827, -123.1207, "ca"], ["Montreal", 45.5019, -73.5674, "ca"], ["Sydney", -33.8688, 151.2093, "au"],
  ["Melbourne", -37.8136, 144.9631, "au"], ["Brisbane", -27.4698, 153.0251, "au"], ["Auckland", -36.8485, 174.7633, "nz"], ["Wellington", -41.2865, 174.7762, "nz"],
  // More European and North American cities (2026-09-29).
  ["Aalborg", 57.0488, 9.9217, "dk"], ["Esbjerg", 55.4765, 8.4594, "dk"], ["Roskilde", 55.6419, 12.0878, "dk"], ["Uppsala", 59.8586, 17.6389, "se"],
  ["Trondheim", 63.4305, 10.3951, "no"], ["Stavanger", 58.97, 5.7331, "no"], ["Tampere", 61.4978, 23.761, "fi"], ["Turku", 60.4518, 22.2666, "fi"],
  ["Tallinn", 59.437, 24.7536, "ee"], ["Riga", 56.9496, 24.1052, "lv"], ["Vilnius", 54.6872, 25.2797, "lt"], ["Gdansk", 54.352, 18.6466, "pl"],
  ["Wroclaw", 51.1079, 17.0385, "pl"], ["Brno", 49.1951, 16.6068, "cz"], ["Bratislava", 48.1486, 17.1077, "sk"], ["Ljubljana", 46.0569, 14.5058, "si"],
  ["Zagreb", 45.815, 15.9819, "hr"], ["Belgrade", 44.7866, 20.4489, "rs"], ["Bucharest", 44.4268, 26.1025, "ro"], ["Sofia", 42.6977, 23.3219, "bg"],
  ["Thessaloniki", 40.6401, 22.9444, "gr"], ["Nice", 43.7102, 7.262, "fr"], ["Bordeaux", 44.8378, -0.5792, "fr"], ["Toulouse", 43.6047, 1.4442, "fr"],
  ["Lille", 50.6292, 3.0573, "fr"], ["Nantes", 47.2184, -1.5536, "fr"], ["Seville", 37.3891, -5.9845, "es"], ["Malaga", 36.7213, -4.4214, "es"],
  ["Bilbao", 43.263, -2.935, "es"], ["Turin", 45.0703, 7.6869, "it"], ["Bologna", 44.4949, 11.3426, "it"], ["Naples", 40.8518, 14.2681, "it"],
  ["Venice", 45.4408, 12.3155, "it"], ["Stuttgart", 48.7758, 9.1829, "de"], ["Dusseldorf", 51.2277, 6.7735, "de"], ["Leipzig", 51.3397, 12.3731, "de"],
  ["Dresden", 51.0504, 13.7373, "de"], ["Salzburg", 47.8095, 13.055, "at"], ["Basel", 47.5596, 7.5886, "ch"], ["Ghent", 51.0543, 3.7174, "be"],
  ["The Hague", 52.0705, 4.3007, "nl"], ["Eindhoven", 51.4416, 5.4697, "nl"], ["Cork", 51.8985, -8.4756, "ie"], ["Cardiff", 51.4816, -3.1791, "gb"],
  ["Belfast", 54.5973, -5.9301, "gb"], ["Brighton", 50.8225, -0.1372, "gb"], ["Philadelphia", 39.9526, -75.1652, "us"], ["San Diego", 32.7157, -117.1611, "us"],
  ["Nashville", 36.1627, -86.7816, "us"], ["Atlanta", 33.749, -84.388, "us"], ["Minneapolis", 44.9778, -93.265, "us"], ["Ottawa", 45.4215, -75.6972, "ca"]
]

// Hosts that aren't the business's own website.
const NOT_OWN_SITE = /(^|\.)(facebook|instagram|twitter|x|tiktok|linktr|linkedin|youtube|google|goo|maps\.app|wa|whatsapp|yelp|tripadvisor|booking|airbnb|foursquare|business\.site|sites\.google|blogspot|wordpress|wix|wixsite|squarespace|weebly|jimdo|jimdofree|webnode|square\.site|carrd|ueniweb|business\.page|pagesjaunes|gelbeseiten|yell|thefork|opentable|treatwell|fresha|booksy|planity|doctolib|zocdoc|just-eat|justeat|deliveroo|ubereats|wolt|doordash|grubhub|toasttab|linktree|beacons|bio)\.[a-z.]+$/i
const VENUE = /^(theatre|cinema|arts_centre|music_venue|nightclub|concert_hall|events_venue|community_centre|stadium|museum|gallery|comedy_club|jazz_club|social_centre)$/

const DAYS: Record<string, string> = { mo: "Mo", tu: "Tu", we: "We", th: "Th", fr: "Fr", sa: "Sa", su: "Su" }
const ORDER = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]
const DAY = "(?:Mo|Tu|We|Th|Fr|Sa|Su)"
const RULE = new RegExp(`(?:(${DAY}(?:\\s*[-,]\\s*${DAY})*)\\s+)?(off|closed|(?:\\d{1,2}:\\d{2}\\s*-\\s*\\d{1,2}:\\d{2}(?:\\s*,\\s*(?=\\d))?)+)`, "gi")

// OSM opening_hours ("Mo-Fr 09:00-17:30; Sa 10:00-14:00") → LAWP business.opening_hours.
// Same rules as locali_private/src/utils/hours.ts parseOpeningHours.
export function osmHours(text: string | undefined): OpeningHours[] | undefined {
  if (!text) return undefined
  if (/^\s*24\/7\s*$/.test(text)) return [{ days: [...ORDER], opens: "00:00", closes: "23:59" }]
  const cleaned = text.replace(/\b(PH|SH)\b[^;,]*/g, " ")
  let out: OpeningHours[] = []
  for (const m of cleaned.matchAll(RULE)) {
    const days: string[] = []
    if (!m[1]) days.push(...ORDER)
    else for (const chunk of m[1].split(",")) {
      const [a, b] = chunk.split("-").map(d => DAYS[d.trim().toLowerCase()])
      if (a && b) { let k = ORDER.indexOf(a); const j = ORDER.indexOf(b); for (let n = 0; n < 7; n++) { days.push(ORDER[k]); if (k === j) break; k = (k + 1) % 7 } }
      else if (a) days.push(a)
    }
    out = out.map(h => ({ ...h, days: h.days.filter(d => !days.includes(d)) })).filter(h => h.days.length)
    if (/^(off|closed)$/i.test(m[2])) continue
    for (const t of m[2].matchAll(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/g)) out.push({ days: [...new Set(days)], opens: t[1].padStart(5, "0"), closes: t[2].padStart(5, "0") })
  }
  return out.length ? out : undefined
}

// OSM addresses use local names and postal districts ("København K", "München"); city pages group
// by one English name, as the search's multilingual keywords do.
const LOCAL_CITY: Record<string, string> = {
  "københavn": "Copenhagen", "kobenhavn": "Copenhagen", "münchen": "Munich", "köln": "Cologne", "wien": "Vienna", "praha": "Prague", "roma": "Rome",
  "milano": "Milan", "firenze": "Florence", "lisboa": "Lisbon", "warszawa": "Warsaw", "kraków": "Krakow", "göteborg": "Gothenburg",
  "bruxelles": "Brussels", "brussel": "Brussels", "antwerpen": "Antwerp", "genève": "Geneva", "zürich": "Zurich", "αθήνα": "Athens",
  "athína": "Athens", "montréal": "Montreal", "den haag": "The Hague", "sevilla": "Seville", "napoli": "Naples", "torino": "Turin", "venezia": "Venice"
}
export function cityName(osmCity: string | undefined, fallback: string): string {
  if (!osmCity) return fallback
  const base = osmCity.trim().replace(/\s+(K|V|Ø|N|S|NV|SV|C|\d{1,2}(\.|e|er)?( arr\.?)?)$/i, "").trim()
  return LOCAL_CITY[base.toLowerCase()] || base
}

export function osmFeatures(t: Record<string, string>): string[] {
  const yes = (v?: string) => v === "yes" || v === "only" || v === "limited"
  const out: string[] = []
  if (yes(t["diet:vegan"])) out.push("vegan")
  if (yes(t["diet:vegetarian"]) || yes(t["diet:vegan"])) out.push("vegetarian")
  if (yes(t["diet:gluten_free"])) out.push("gluten_free")
  if (t.wheelchair === "yes") out.push("wheelchair")
  if (t.outdoor_seating === "yes") out.push("outdoor_seating")
  if (/^(yes|wlan|wifi|free)$/.test(t.internet_access || "")) out.push("wifi")
  if (t.dog === "yes" || t.dog === "leashed") out.push("dogs")
  if (t.changing_table === "yes" || t.kids_area === "yes" || t["kids_area:indoor"] === "yes") out.push("kids")
  return out
}

type Place = { domain: string, path: string, type: string, venue: boolean, business: Business }

function kindOf(tags: Record<string, string>): string {
  for (const key of ["shop", "amenity", "craft", "healthcare", "office", "tourism", "leisure"]) {
    const v = tags[key]
    if (v && v !== "yes") return v.replace(/_/g, " ")
  }
  return "business"
}

export function placeFrom(el: any, city: string, country: string): Place | null {
  const tags: Record<string, string> = el.tags || {}
  const website = tags.website || tags["contact:website"] || tags.url
  if (!website || !tags.name) return null
  // Closed places ("vacant", "disused:shop=…") aren't businesses any more.
  if (tags.shop === "vacant" || tags.amenity === "vacant" || Object.keys(tags).some(k => /^(disused|abandoned|was|demolished|removed):/.test(k))) return null
  let url: URL
  try { url = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`) } catch { return null }
  const domain = url.hostname.toLowerCase().replace(/^www\./, "")
  if (!domain.includes(".") || NOT_OWN_SITE.test(domain) || /^\d+\.\d+\.\d+\.\d+$/.test(domain)) return null
  const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon
  const street = [tags["addr:street"], tags["addr:housenumber"]].filter(Boolean).join(" ")
  const type = kindOf(tags)
  const business: Business = {
    type, name: tags.name,
    ...(tags.phone || tags["contact:phone"] ? { telephone: (tags.phone || tags["contact:phone"]).split(";")[0].trim() } : {}),
    ...(tags.email || tags["contact:email"] ? { email: (tags.email || tags["contact:email"]).split(";")[0].trim() } : {}),
    address: { ...(street ? { street } : {}), city: cityName(tags["addr:city"], city), ...(tags["addr:postcode"] ? { postcode: tags["addr:postcode"] } : {}), country: (tags["addr:country"] || country).toUpperCase() },
    ...(typeof lat === "number" && typeof lon === "number" ? { geo: { lat, lon } } : {}),
    ...(osmHours(tags.opening_hours) ? { opening_hours: osmHours(tags.opening_hours) } : {}),
    // Things people search for ("vegan", "dog friendly", "wheelchair"), and hotel stars.
    ...(osmFeatures(tags).length ? { features: osmFeatures(tags) } : {}),
    ...(/^[1-5](\.5)?S?$/.test(tags.stars || "") ? { stars: parseFloat(tags.stars) } : {}),
    // ODbL attribution: site pages show "© OpenStreetMap contributors" for these details.
    source: "openstreetmap"
  } as Business
  return { domain, path: url.pathname.replace(/\/+$/, "") || "/", type, venue: VENUE.test(tags.amenity || tags.leisure || tags.tourism || ""), business }
}

export async function overpass(lat: number, lon: number): Promise<any[]> {
  const sel = `["name"][~"^(shop|amenity|craft|healthcare|office|tourism|leisure)$"~"."]`
  const q = `[out:json][timeout:170];(nwr(around:${RADIUS_M},${lat},${lon})["website"]${sel};nwr(around:${RADIUS_M},${lat},${lon})["contact:website"]${sel};);out center tags 6000;`
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(OVERPASS, { method: "POST", headers: { "User-Agent": OSM_AGENT, "Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body: `data=${encodeURIComponent(q)}`, signal: AbortSignal.timeout(200000) }).catch(() => null)
    if (r?.ok) return (await r.json()).elements || []
    console.log(`Overpass ${r?.status || "failed"}; retrying in 60s`)
    await new Promise(res => setTimeout(res, 60000))
  }
  return []
}

async function state(id: string): Promise<number> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/crawler_state?id=eq.${id}&select=value`, { headers: SUPABASE_HEADERS }).catch(() => null)
  const rows = r?.ok ? await r.json() : []
  return Number(rows?.[0]?.value) || 0
}

async function setState(id: string, value: number) {
  await fetch(`${SUPABASE_URL}/rest/v1/crawler_state?on_conflict=id`, {
    method: "POST", headers: { ...SUPABASE_HEADERS, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates" },
    body: JSON.stringify({ id, value })
  }).catch(() => {})
}

async function known(domains: string[]): Promise<Map<string, { business: boolean, owner: boolean }>> {
  const out = new Map<string, { business: boolean, owner: boolean }>()
  for (let i = 0; i < domains.length; i += 100) {
    const list = encodeURIComponent(domains.slice(i, i + 100).map(d => `"${d}"`).join(","))
    const r = await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?select=domain,business,owner_key,native&domain=in.(${list})`, { headers: SUPABASE_HEADERS })
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`)
    for (const row of await r.json()) out.set(row.domain, { business: !!row.business, owner: !!row.owner_key || !!row.native })
  }
  return out
}

// Events pages venues commonly use; the homepage is read too.
const EVENT_PATHS = ["/", "/events", "/whats-on", "/program", "/programme", "/calendar", "/kalender", "/agenda", "/veranstaltungen", "/konzerte", "/shows", "/concerts"]

export async function venueEvents(domain: string): Promise<number> {
  let saved = 0
  if (!await isPublicHost(domain)) return 0
  for (const path of EVENT_PATHS) {
    if (Date.now() - started > TIME_BUDGET_MS) break
    if (!await robotsAllows(domain, path)) continue
    const r = await fetchPublic(`https://${domain}${path}`, { headers: { "User-Agent": USER_AGENT, "Accept": "text/html" }, signal: AbortSignal.timeout(8000) }).catch(() => null)
    if (!r?.ok || !(r.headers.get("content-type") || "").includes("html")) continue
    const events = extractEvents((await r.text()).slice(0, 600_000), r.url)
    if (events.length) { await saveEvents(domain, events); saved += events.length }
    if (saved >= 60) break
  }
  return saved
}

// A real LAWP from OSM alone, for businesses whose website can't be read (blocked, JavaScript-only).
function fromOsm(p: Place): any {
  const b = p.business
  const where = [b.address?.street, b.address?.city].filter(Boolean).join(", ")
  const actions: any[] = [{ id: "visit", name: "Visit website", description: `Open ${b.name}'s website`, intent: ["website", p.type, "info"], input: { type: "none", required: false }, url: `https://${p.domain}` }]
  if (b.telephone) actions.push({ id: "call", name: "Call", description: `Call ${b.telephone}`, intent: ["call", "phone", "telephone", "book", "appointment"], input: { type: "none", required: false } })
  if (b.email) actions.push({ id: "contact", name: "Contact", description: `Email ${b.email}`, intent: ["contact", "email", "message"], input: { type: "text", required: false } })
  if (b.geo) actions.push({ id: "directions", name: "Get directions", description: `Directions to ${b.name}${where ? ` (${where})` : ""}`, intent: ["directions", "map", "address", "location"], input: { type: "none", required: false }, url: `https://www.openstreetmap.org/?mlat=${b.geo.lat}&mlon=${b.geo.lon}#map=18/${b.geo.lat}/${b.geo.lon}` })
  return {
    domain: p.domain, name: b.name, language: "en",
    pages: { "/": { title: b.name, content: `${b.name} is a ${p.type}${where ? ` at ${where}` : ""}.${b.opening_hours?.length ? " Opening hours are listed." : ""} Details from OpenStreetMap contributors.` } },
    actions
  }
}

async function crawlNew(p: Place): Promise<"saved" | "osm" | "skipped"> {
  // Security: OSM websites are community-edited; only public hosts are fetched.
  if (!await isPublicHost(p.domain) || !await robotsAllows(p.domain, "/")) return "skipped"
  const page = await fetchSite(p.domain).catch(() => null)
  let lawp: any = page ? heuristicLAWP(p.domain, page.raw, page.isHtml) : null
  if (!lawp?.actions?.length) { const saved = await rescue(p.domain, page, false).catch(() => null); lawp = saved?.lawp || null }
  const own = page?.isHtml ? extractBusiness(page.raw) : null
  // The site's own schema.org details win; OSM fills the gaps (it's usually better on hours and location).
  const business = { ...p.business, ...Object.fromEntries(Object.entries(own || {}).filter(([, v]) => v != null)) }
  const osmOnly = !lawp?.actions?.length
  if (osmOnly) lawp = fromOsm(p)
  else if (page) lawp = withBookingLinks(lawp, page.raw)
  lawp = { ...lawp, pages: cleanPages(lawp.pages) || lawp.pages, business }
  await saveSite(lawp, undefined, "heuristic")
  if (page?.isHtml) await saveEvents(p.domain, extractEvents(page.raw, `https://${p.domain}/`))
  return osmOnly ? "osm" : "saved"
}

async function addBusiness(p: Place) {
  // Only fills an empty business column; owner-edited and native sites are never touched.
  await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?domain=eq.${encodeURIComponent(p.domain)}&business=is.null&owner_key=is.null&native=is.false`, {
    method: "PATCH", headers: { ...SUPABASE_HEADERS, "Content-Type": "application/json", "Prefer": "return=minimal" }, body: JSON.stringify({ business: p.business })
  })
}

async function city([name, lat, lon, country]: typeof CITIES[number]): Promise<boolean | "empty"> {
  const elements = await overpass(lat, lon)
  // No places at all means the map service didn't answer: try this city again next run.
  if (!elements.length) { console.log(`${name}: no answer from OpenStreetMap — retrying next run`); return "empty" }
  const places = new Map<string, Place>()
  const perDomain = new Map<string, number>()
  for (const el of elements) {
    const p = placeFrom(el, name, country)
    if (!p) continue
    perDomain.set(p.domain, (perDomain.get(p.domain) || 0) + 1)
    if (!places.has(p.domain) || p.path === "/") places.set(p.domain, p)
  }
  // Brands with several branches in one city are chains: their site isn't one local business.
  for (const [d, n] of perDomain) if (n > 2) places.delete(d)
  const list = [...places.values()]
  const index = await known(list.map(p => p.domain))
  const counts = { saved: 0, osm: 0, skipped: 0, business: 0, events: 0 }
  // New websites first; a big city takes a few runs (the city only advances once it's done).
  const queue = [...list.filter(p => !index.has(p.domain)), ...list.filter(p => index.has(p.domain))]
  async function worker() {
    while (queue.length && Date.now() - started < TIME_BUDGET_MS && !await searchNeedsTheDatabase()) {
      const p = queue.shift()!
      try {
        const k = index.get(p.domain)
        let firstTime = false
        if (!k) { const outcome = await crawlNew(p); counts[outcome]++; firstTime = outcome !== "skipped" }
        else if (!k.business && !k.owner && p.path === "/") { await addBusiness(p); counts.business++; firstTime = true }
        // Venue events pages are read the first time a venue is seen; the events job keeps them fresh.
        if (p.venue && firstTime) counts.events += await venueEvents(p.domain)
      } catch (e) { console.log(`  ${p.domain}: ${e}`) }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  console.log(`${name}: ${elements.length} OSM places, ${list.length} own websites — ${counts.saved} new sites, ${counts.osm} new from OSM details only, ${counts.business} got business details, ${counts.events} events, ${counts.skipped} skipped (robots)`)
  return queue.length === 0
}

async function main() {
  if (!process.env.SUPABASE_SERVICE_KEY) { console.error("Missing SUPABASE_SERVICE_KEY"); process.exit(1) }
  let at = await state("osm_city")
  for (let n = 0; n < CITIES_PER_RUN && Date.now() - started < TIME_BUDGET_MS && !await searchNeedsTheDatabase(); n++) {
    const c = CITIES[at % CITIES.length]
    const finished = await city(c)
    if (finished === "empty") {
      // At most two retries per city, then move on (it may really have nothing).
      const retries = await state("osm_city_retries")
      if (retries < 2) { await setState("osm_city_retries", retries + 1); break }
      await setState("osm_city_retries", 0)
    } else if (!finished) break
    else await setState("osm_city_retries", 0)
    at++
    await setState("osm_city", at)
    await new Promise(r => setTimeout(r, 10000)) // be gentle with the public Overpass server
  }
}

if (!process.env.OSM_NO_MAIN) main().catch(e => { console.error(e); process.exit(1) })
