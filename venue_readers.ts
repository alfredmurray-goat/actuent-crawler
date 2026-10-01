import { saveEvents, robotsAllows } from "./shared"
import { USER_AGENT } from "./robots"

// Readers for big Copenhagen venues whose concerts aren't published as schema.org events (so the
// generic venue_events reader finds nothing): each reads the venue's own listing (its CMS API, the
// JSON in its calendar page, or its concert pages) and saves to lawp_events like any other event.
// Run from venue_events.ts, or alone: npx tsx venue_readers.ts

type Ev = { url: string, name: string, start_date: string, venue: string, city: string, country: string, price?: number | null, currency?: string | null, description?: string | null }

const HEADERS = { "User-Agent": USER_AGENT, "Accept": "application/json, text/html" }
const ZONE = "Europe/Copenhagen"
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, maj: 5, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, okt: 10, oct: 10, nov: 11, dec: 12 }
const pause = (ms: number) => new Promise(r => setTimeout(r, ms))

async function get(url: string, extra: Record<string, string> = {}): Promise<Response | null> {
  const u = new URL(url)
  if (!await robotsAllows(u.hostname, u.pathname)) return null
  const r = await fetch(url, { headers: { ...HEADERS, ...extra }, signal: AbortSignal.timeout(20000) }).catch(() => null)
  return r?.ok ? r : null
}

// Copenhagen local date and time → UTC ISO.
function local(y: number, m: number, d: number, time = "20:00"): string {
  const [h, mi] = time.split(/[:.]/).map(Number)
  const guess = Date.UTC(y, m - 1, d, h || 0, mi || 0)
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(guess)).map(p => [p.type, p.value]))
  const shown = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute))
  return new Date(guess - (shown - guess)).toISOString()
}
// "10. okt" without a year: the next 10 October from today.
function nextDate(d: number, m: number, time: string): string {
  const now = new Date(), y = now.getUTCFullYear()
  const iso = local(y, m, d, time)
  return Date.parse(iso) < now.getTime() - 30 * 86400000 ? local(y + 1, m, d, time) : iso
}
const text = (v: string) => String(v || "").replace(/<[^>]+>/g, " ").replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(Number(c)))
  .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/&ndash;/g, "–").replace(/\s+/g, " ").trim()
const upcoming = (e: Ev) => Date.parse(e.start_date) > Date.now() - 6 * 3600000

// VEGA: Payload CMS API (all upcoming concerts in Store VEGA, Lille VEGA and Ideal Bar).
async function vega(): Promise<Ev[]> {
  const out: Ev[] = []
  const since = new Date(Date.now() - 86400000).toISOString()
  for (let page = 1; page <= 10; page++) {
    const r = await get(`https://payload.vega.dk/api/events?limit=100&depth=1&sort=firstDate&page=${page}&where%5BlastDate%5D%5Bgreater_than_equal%5D=${encodeURIComponent(since)}`)
    if (!r) break
    const d: any = await r.json()
    for (const e of d.docs || []) {
      if (!e.slug || !e.firstDate) continue
      const genre = [e.genre?.name, e.secondaryGenre?.name].filter(Boolean).join(", ")
      out.push({
        url: `https://vega.dk/event/${e.slug}`, name: text(e.resolvedTitle || e.title), start_date: new Date(e.firstDate).toISOString(),
        venue: `${e.venue?.name || "VEGA"}, VEGA`, city: "Copenhagen", country: "DK", price: typeof e.price === "number" ? e.price : null, currency: "DKK",
        description: [genre ? `Concert (${genre})` : "Concert", e.meta?.description ? text(e.meta.description) : ""].filter(Boolean).join(". ").slice(0, 400)
      })
    }
    if (!d.hasNextPage) break
    await pause(1000)
  }
  return out
}

// Royal Arena: the site's own event search API.
async function royalArena(): Promise<Ev[]> {
  const r = await get("https://www.royalarena.dk/__api/search/events?culture=da-DK&PageSize=200", { "X-Culture": "da-DK" })
  if (!r) return []
  const d: any = await r.json()
  return (d.documents || []).filter((e: any) => !e.isDeleted && e.eventDateUtc).map((e: any) => {
    const loc = e.localizations?.[0] || {}
    const genres = (e.genres || []).map((g: any) => g.name).join(", ")
    const price = (e.tickets || []).map((t: any) => Number(t.priceFrom ?? t.price)).filter((n: number) => n > 0).sort((a: number, b: number) => a - b)[0]
    const path = loc.url || e.url || ""
    return {
      url: path.startsWith("http") ? path : `https://www.royalarena.dk${path}`, name: text(loc.name || e.name), start_date: new Date(e.eventDateUtc).toISOString(),
      venue: "Royal Arena", city: "Copenhagen", country: "DK", price: price || null, currency: price ? "DKK" : null,
      description: [genres ? `Concert (${genres})` : "Concert", text(loc.description || "").slice(0, 300)].filter(Boolean).join(". ")
    }
  })
}

// DR Koncerthuset: the calendar page carries every event as JSON (data-component-args).
async function drKoncerthuset(): Promise<Ev[]> {
  const r = await get("https://www.drkoncerthuset.dk/kalender/")
  if (!r) return []
  const html = await r.text()
  const m = html.match(/data-vue-component="vue-events-list" data-component-args="([^"]*)"/)
  if (!m) return []
  const decoded = m[1].replace(/&#xA;/g, "\n").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
  let d: any
  try { d = JSON.parse(decoded) } catch { return [] }
  const list: any[] = (d.dynamicResults || []).flat()
  // Only DR's own halls: touring concerts elsewhere in Denmark (Taastrup, Aarhus…) aren't Copenhagen.
  const HALLS = /koncertsal|studie|foyer|koncerthus|dr byen|kuppel/i
  return list.filter(e => e.entryType === "event" && e.url && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(e.orderDate || "") && HALLS.test(e.venue || "Koncertsalen")).map(e => {
    const [date, time] = String(e.orderDate).split("T")
    const [y, mo, da] = date.split("-").map(Number)
    return {
      url: `https://www.drkoncerthuset.dk${e.url}`, name: text(e.title + (e.subTitle ? ` – ${e.subTitle}` : "")), start_date: local(y, mo, da, time.slice(0, 5)),
      venue: `${e.venue || "DR Koncerthuset"}, DR Koncerthuset`, city: "Copenhagen", country: "DK",
      description: [e.ensembleLabel, (e.allCategoriesNames || []).join(", "), e.info?.label].filter(Boolean).map(text).join(". ").slice(0, 400)
    }
  })
}

// WordPress venues with a "concert" sitemap and one page per concert (Amager Bio / BETA, Pumpehuset).
async function concertPages(sitemaps: string[], parse: (html: string, url: string) => Ev | null, max = 160): Promise<Ev[]> {
  const urls: string[] = []
  const recent = Date.now() - 200 * 86400000
  for (const s of sitemaps) {
    const r = await get(s)
    if (!r) continue
    for (const m of (await r.text()).matchAll(/<loc>([^<]+)<\/loc>\s*(?:<lastmod>([^<]+)<\/lastmod>)?/g)) {
      if (!m[2] || Date.parse(m[2]) >= recent) urls.push(m[1])
    }
  }
  const out: Ev[] = []
  for (const u of urls.slice(-max)) {
    const r = await get(u)
    if (r) { const e = parse(await r.text(), u); if (e && upcoming(e)) out.push(e) }
    await pause(700)
  }
  return out
}

function amagerBio(html: string, url: string): Ev | null {
  const t = text(html.match(/<title>([^<]+)<\/title>/)?.[1] || "")
  const body = text(html)
  const date = body.match(/Dato:\s*\S+\s+(\d{1,2})\.\s*([a-zæøå]{3})/i)
  if (!date || !MONTHS[date[2].toLowerCase()]) return null
  const start = body.match(/Start:\s*(\d{1,2}[:.]\d{2})/i)?.[1] || "20:00"
  const price = Number(body.match(/Forsalg:\s*kr\.?\s*(\d+)/i)?.[1]) || null
  // "The Bones of J.R. Jones – BETA, 10. oktober"
  const [name, place] = t.split(/\s+[–-]\s+/)
  const hall = /beta/i.test(place || "") ? "BETA" : "Amager Bio"
  return { url, name: name || t, start_date: nextDate(Number(date[1]), MONTHS[date[2].toLowerCase()], start), venue: hall === "BETA" ? "BETA, Amager Bio" : "Amager Bio", city: "Copenhagen", country: "DK", price, currency: price ? "DKK" : null, description: "Concert" }
}

function pumpehuset(html: string, url: string): Ev | null {
  const og = text(html.match(/<meta property="og:title" content="([^"]+)"/)?.[1] || "")
  const name = og.replace(/^Oplev\s+/i, "").replace(/\s+i Pumpehuset.*$/i, "").replace(/\s+(spiller|giver koncert|kommer)$/i, "").trim()
  const info = text(html.slice(html.indexOf("single-event-info"), html.indexOf("single-event-info") + 4000))
  const date = info.match(/(\d{1,2})\.\s*([a-zæøå]{3})[a-z]*\.?\s+(20\d\d)/i)
  if (!name || !date || !MONTHS[date[2].toLowerCase()]) return null
  const start = info.match(/Showet starter\s*(\d{1,2}[:.]\d{2})/i)?.[1] || info.match(/dørene åbner\s*(\d{1,2}[:.]\d{2})/i)?.[1] || "20:00"
  const price = Number(info.match(/(\d+)\s*Kr\./i)?.[1]) || null
  const desc = text(html.match(/<meta name="description" content="([^"]+)"/)?.[1] || "")
  return { url, name, start_date: local(Number(date[3]), MONTHS[date[2].toLowerCase()], Number(date[1]), start), venue: "Pumpehuset", city: "Copenhagen", country: "DK", price, currency: price ? "DKK" : null, description: desc ? `Concert. ${desc}` : "Concert" }
}

export const READERS: Record<string, () => Promise<Ev[]>> = {
  "vega.dk": vega,
  "royalarena.dk": royalArena,
  "drkoncerthuset.dk": drKoncerthuset,
  "ab-b.dk": () => concertPages(["https://ab-b.dk/concert-sitemap.xml"], amagerBio),
  "pumpehuset.dk": () => concertPages(["https://pumpehuset.dk/concert-sitemap.xml", "https://pumpehuset.dk/concert-sitemap4.xml"], pumpehuset)
}

export async function readVenues(only?: string[]): Promise<number> {
  let total = 0
  for (const [domain, read] of Object.entries(READERS)) {
    if (only?.length && !only.includes(domain)) continue
    try {
      const events = (await read()).filter(e => e.name && upcoming(e))
      for (let i = 0; i < events.length; i += 200) await saveEvents(domain, events.slice(i, i + 200))
      console.log(`${domain}: ${events.length} events`)
      total += events.length
    } catch (e) { console.log(`${domain}: failed (${(e as Error).message})`) }
  }
  return total
}

if (process.argv[1]?.endsWith("venue_readers.ts")) {
  const dry = process.env.DRY_RUN === "1"
  if (dry) {
    (async () => {
      for (const [domain, read] of Object.entries(READERS)) {
        if (process.env.ONLY && !process.env.ONLY.split(",").includes(domain)) continue
        const ev = (await read()).filter(upcoming)
        console.log(`${domain}: ${ev.length}`, ev.slice(0, 3).map(e => `${e.start_date} ${e.name} | ${e.venue} | ${e.price ?? ""}`))
      }
    })()
  } else {
    if (!process.env.SUPABASE_SERVICE_KEY) { console.error("Missing SUPABASE_SERVICE_KEY"); process.exit(1) }
    readVenues(process.env.ONLY?.split(",")).then(n => console.log(`${n} venue events saved`))
  }
}
