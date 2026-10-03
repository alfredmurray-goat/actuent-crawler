import { saveEvents, robotsAllows } from "./shared"
import { USER_AGENT } from "./robots"
import { extractEvents } from "./business"

// Readers for big venues whose concerts aren't published as schema.org events (so the
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
  .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/&(aelig|AElig|oslash|Oslash|aring|Aring|eacute|Eacute|auml|Auml|ouml|Ouml|uuml|Uuml|ndash|mdash|hellip|rsquo|lsquo|rdquo|ldquo);/g, (_, n) => ({ aelig: "æ", AElig: "Æ", oslash: "ø", Oslash: "Ø", aring: "å", Aring: "Å", eacute: "é", Eacute: "É", auml: "ä", Auml: "Ä", ouml: "ö", Ouml: "Ö", uuml: "ü", Uuml: "Ü", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" } as Record<string, string>)[n]).replace(/\s+/g, " ").trim()
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

// ── United States (Actuent's main market) ──────────────────────────────────────────────────────

// AEG Presents / Bowery Presents: every venue's listing is a public JSON feed (the same file the
// venue's own site shows): /json/events/<n>/events.json per venue (Beacon Theatre, Webster Hall, the
// Fonda, Climate Pledge Arena…) plus the shared Bowery Presents feeds (Terminal 5, Brooklyn Steel,
// Music Hall of Williamsburg). Feed numbers are found by trying 1–400 each run (small files, a CDN).
const AEG = "https://aegwebprod.blob.core.windows.net/json"
const AEG_SHARED = [`${AEG}/resources/8/events/208lbnmkq5/events.json`, `${AEG}/resources/8/events/301mbke409/events.json`]
async function aeg(): Promise<Ev[]> {
  const urls = [...AEG_SHARED, ...Array.from({ length: 400 }, (_, i) => `${AEG}/events/${i + 1}/events.json`)]
  const seen = new Set<string>(), out: Ev[] = []
  let next = 0
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < urls.length) {
      const r = await fetch(urls[next++], { headers: HEADERS, signal: AbortSignal.timeout(15000) }).catch(() => null)
      if (!r?.ok) continue
      const d: any = await r.json().catch(() => null)
      for (const e of d?.events || []) {
        const utc = String(e?.eventDateTimeUTC || "")
        const when = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(utc) ? utc : `${utc}Z`)
        if (!e?.eventId || seen.has(e.eventId) || e.active === false || isNaN(when)) continue
        seen.add(e.eventId)
        const v = e.venue || {}, t = e.ticketing || {}
        if (/cancel|postpone/i.test(String(t.status || ""))) continue
        const price = Number(String(e.ticketPriceLow || "").replace(/[^0-9.]/g, "")) || null
        const support = e.title?.supportingText ? ` with ${text(e.title.supportingText)}` : ""
        out.push({
          url: t.url || t.ticketURL || `https://www.axs.com/events/${e.eventId}`, name: text(e.title?.eventTitleText || e.title?.headlinersText || ""),
          start_date: new Date(when).toISOString(), venue: text(v.title || ""), city: v.city || "",
          country: v.countryCode || (v.country === "United States" ? "US" : v.country || ""), price, currency: price ? (e.currency || "USD") : null,
          description: [`Concert${support}`, v.address_line ? `at ${text(v.title)}, ${v.address_line}` : "", e.age || ""].filter(Boolean).join(". ").slice(0, 400)
        })
      }
    }
  }))
  return out
}

// TicketWeb's WordPress plugin (many US indie venues): "tw-section" blocks with name, date, time,
// venue and address. Mercury East: Bowery Ballroom, Mercury Lounge.
const MONTH_EN: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }
const US_ZONES: Record<string, string> = { "New York": "America/New_York", Brooklyn: "America/New_York" }
function zoned(y: number, m: number, d: number, time: string, zone: string): string {
  const [h, mi] = time.split(":").map(Number)
  const guess = Date.UTC(y, m - 1, d, h || 0, mi || 0)
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(guess)).map(p => [p.type, p.value]))
  const shown = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute))
  return new Date(guess - (shown - guess)).toISOString()
}
async function ticketWeb(pages: string[]): Promise<Ev[]> {
  const out: Ev[] = [], seen = new Set<string>()
  for (const page of pages) {
    const r = await get(page)
    if (!r) continue
    const html = await r.text()
    for (const block of html.split('class="tw-section"').slice(1)) {
      const link = block.match(/class="tw-name">\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
      const date = text(block.match(/class="tw-event-date">([^<]+)</)?.[1] || "").match(/([A-Za-z]{3})[a-z]*\s+(\d{1,2}),\s*(\d{4})/)
      if (!link || !date || !MONTH_EN[date[1].toLowerCase()] || /tw_cancelled|>\s*Cancelled\s*</i.test(block)) continue
      const t = text(block.match(/class="tw-event-time">([^<]+)</)?.[1] || "").match(/(\d{1,2}):(\d{2})\s*(am|pm)/i)
      const hour = t ? (Number(t[1]) % 12) + (/pm/i.test(t[3]) ? 12 : 0) : 20
      const venue = text(block.match(/<span class="tw-venue-name">([\s\S]*?)<\/span>/)?.[1] || "")
      const city = /brooklyn/i.test(block) ? "Brooklyn" : "New York"
      const key = `${link[1]}|${date[0]}`
      if (seen.has(key)) continue
      seen.add(key)
      const price = Number(text(block.match(/class="tw-price">([\s\S]*?)<\/span>/)?.[1] || "").replace(/[^0-9.]/g, "")) || null
      out.push({ url: link[1], name: text(link[2]), start_date: zoned(Number(date[3]), MONTH_EN[date[1].toLowerCase()], Number(date[2]), `${hour}:${t ? t[2] : "00"}`, US_ZONES[city]),
        venue, city, country: "US", price, currency: price ? "USD" : null, description: "Concert" })
    }
    await pause(1000)
  }
  return out
}

// Venues that publish schema.org events: read with the generic reader, city set when missing.
async function schemaEvents(pages: { url: string, city: string, country: string }[]): Promise<Ev[]> {
  const out: Ev[] = []
  for (const p of pages) {
    const r = await get(p.url)
    if (!r) continue
    for (const e of extractEvents(await r.text(), p.url) as any[]) {
      if (!e?.url || !e.start_date) continue
      out.push({ ...e, name: text(e.name), city: e.city || p.city, country: e.country || p.country, venue: e.venue || new URL(p.url).hostname.replace(/^www\./, "") })
    }
    await pause(1000)
  }
  return out
}

// Los Angeles Public Library: daytime events (storytimes, workshops, nature walks, exhibitions) from
// the main events page and each of its ~73 branch pages (one page a second). Exhibitions that already
// started show from today at 10:00.
async function lapl(): Promise<Ev[]> {
  const base = "https://www.lapl.org"
  const list = await get(`${base}/branches`)
  const branches = list ? [...new Set([...(await list.text()).matchAll(/href="(\/branches\/[a-z0-9-]+)"/g)].map(m => m[1]))] : []
  const out: Ev[] = [], seen = new Set<string>()
  const today = new Date(), todayKey = Number(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(today).replace(/-/g, ""))
  for (const page of ["/events", ...branches]) {
    const r = await get(`${base}${page}`)
    if (r) for (const card of (await r.text()).split('class="c-teaser-card__heading"').slice(1)) {
      const link = card.match(/<a href="([^"]+)"[\s\S]*?<span class="e-link__text">([\s\S]*?)<\/span>/)
      const date = card.match(/meta-item--date">\s*<span[^>]*>date:<\/span>\s*([^<]+)/)?.[1].trim() || ""
      if (!link || !link[1].startsWith("/events/") || !date) continue
      const url = `${base}${link[1]}`
      if (seen.has(url)) continue
      seen.add(url)
      const [from, until] = date.split(/\s*-\s*/).map(d => d.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/)).map(m => m ? [Number(m[3]), Number(m[1]), Number(m[2])] : null)
      if (!from) continue
      let [y, m, d] = from
      const key = (x: number[]) => x[0] * 10000 + x[1] * 100 + x[2]
      const time = card.match(/meta-item--time">\s*<span[^>]*>time:<\/span>\s*([^<]+)/)?.[1].trim() || ""
      const t = time.match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i)
      let hm = t ? `${(Number(t[1]) % 12) + (/pm/i.test(t[3]) ? 12 : 0)}:${t[2] || "00"}` : "10:00"
      if (key(from) < todayKey) {
        if (!until || key(until) < todayKey) continue
        const [ty, tm, td] = [Math.floor(todayKey / 10000), Math.floor(todayKey / 100) % 100, todayKey % 100];[y, m, d] = [ty, tm, td]; hm = "10:00"
      }
      const branch = text(card.match(/meta-item--location">[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/)?.[1] || "").trim()
      const about = text(card.match(/c-teaser-card__text">([\s\S]*?)<\/div>/)?.[1] || "").replace(/\s+/g, " ").trim()
      out.push({ url, name: text(link[2]).replace(/\s+/g, " ").trim(), start_date: zoned(y, m, d, hm, "America/Los_Angeles"),
        venue: branch ? `${/library/i.test(branch) ? branch : `${branch} Library`} (LAPL)` : "Los Angeles Public Library", city: "Los Angeles", country: "US", price: 0, currency: "USD",
        description: [`Free library event${time && !/all day/i.test(time) ? `, ${time}` : ""}`, about].filter(Boolean).join(". ").slice(0, 400) })
    }
    await pause(1000)
  }
  return out
}

// LibCal (Springshare): the calendar system many public libraries use. Its calendar page reads a
// public JSON list (/ajax/calendar/list), the same for every library, so one reader covers them all.
// Mostly daytime and free: storytimes, workshops, tech help, exhibitions, walks. (Denver's LibCal
// disallows all bots in robots.txt, so it isn't listed.)
const LIBCAL: { sub: string, name: string, city: string, zone: string }[] = [
  { sub: "houstonlibrary", name: "Houston Public Library", city: "Houston", zone: "America/Chicago" },
  { sub: "cpl", name: "Cleveland Public Library", city: "Cleveland", zone: "America/New_York" },
  { sub: "fairfaxcounty", name: "Fairfax County Public Library", city: "Fairfax", zone: "America/New_York" },
  { sub: "ocpl", name: "Orange County Public Libraries", city: "Orange County", zone: "America/Los_Angeles" },
  { sub: "richmondpubliclibrary", name: "Richmond Public Library", city: "Richmond", zone: "America/New_York" }
]
async function libcal(): Promise<Ev[]> {
  const out: Ev[] = []
  for (const lib of LIBCAL) {
    for (let page = 1; page <= 12; page++) {
      const r = await get(`https://${lib.sub}.libcal.com/ajax/calendar/list?c=-1&date=0000-00-00&perpage=48&page=${page}`, { "X-Requested-With": "XMLHttpRequest", "Accept": "application/json" })
      const d: any = r ? await r.json().catch(() => null) : null
      const rows: any[] = d?.results || []
      for (const e of rows) {
        const m = String(e.startdt || "").match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/)
        if (!m || !e.url || !e.title || /^cancel+ed\b/i.test(e.title) || e.online_event === true) continue
        const place = e.campus || (e.location && !/room|floor|study|virtual/i.test(e.location) ? e.location : "")
        const cost = String(e.registration_cost || "").match(/\d+(\.\d+)?/)
        const what = [e.categories, (e.audiences || []).map((a: any) => a.name).join(", ")].filter(Boolean).join(" · ")
        out.push({ url: e.url, name: text(e.title).trim(), start_date: zoned(Number(m[1]), Number(m[2]), Number(m[3]), e.all_day ? "10:00" : `${m[4]}:${m[5]}`, lib.zone),
          venue: place ? `${text(place)} (${lib.name})` : lib.name, city: lib.city, country: "US", price: cost ? Number(cost[0]) : 0, currency: "USD",
          description: [`Library event${e.all_day ? ", all day" : `, ${e.start}${e.end ? `–${e.end}` : ""}`}`, what, text(e.shortdesc || "").replace(/\s+/g, " ").trim()].filter(Boolean).join(". ").slice(0, 400) })
      }
      if (rows.length < 48) break
      await pause(1000)
    }
    await pause(1000)
  }
  return out
}

// The Events Calendar (WordPress plugin): the same public JSON API on every site that uses it
// (/wp-json/tribe/events/v1/events). Parks, gardens, museums and neighbourhood groups: much of it
// daytime (walks, tours, workshops, festivals). `delay` honours a site's robots.txt Crawl-delay.
const TRIBE: { site: string, city: string, delay?: number }[] = [
  { site: "www.statenislandmuseum.org", city: "Staten Island" },
  { site: "riversideparknyc.org", city: "New York", delay: 10000 },
  { site: "www.randallsisland.org", city: "New York" },
  { site: "flatironnomad.nyc", city: "New York" },
  { site: "www.mocanyc.org", city: "New York" },
  { site: "www.littleisland.org", city: "New York" },
  { site: "www.weeksvillesociety.org", city: "Brooklyn" }
]
const entities = (v: string) => text(v).replace(/&#038;|&amp;/g, "&").replace(/&#8211;|&ndash;/g, "–").replace(/&#8217;|&#8216;/g, "’").replace(/&#8220;|&#8221;/g, "\"").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim()
async function tribe(): Promise<Ev[]> {
  const out: Ev[] = []
  for (const t of TRIBE) {
    for (let page = 1; page <= 6; page++) {
      const r = await get(`https://${t.site}/wp-json/tribe/events/v1/events?per_page=50&page=${page}&start_date=now`, { "Accept": "application/json" })
      const d: any = r ? await r.json().catch(() => null) : null
      for (const e of d?.events || []) {
        const utc = Date.parse(`${String(e.utc_start_date || "").replace(" ", "T")}Z`)
        if (!e.url || !e.title || isNaN(utc) || /cancel+ed/i.test(e.title)) continue
        const v = Array.isArray(e.venue) ? null : e.venue
        const price = String(e.cost || "").match(/\d+(\.\d+)?/)
        out.push({ url: e.url, name: entities(e.title), start_date: new Date(utc).toISOString(),
          venue: entities(v?.venue || t.site.replace(/^www\./, "")), city: v?.city || t.city, country: "US",
          price: /free/i.test(String(e.cost || "")) ? 0 : price ? Number(price[0]) : null, currency: price || /free/i.test(String(e.cost || "")) ? "USD" : null,
          description: entities(e.excerpt || e.description || "").slice(0, 400) })
      }
      if (!d?.next_rest_url) break
      await pause(t.delay || 1000)
    }
    await pause(t.delay || 1000)
  }
  return out
}

// Brooklyn Botanic Garden: classes, tours and garden events ("Saturday, October 3, 2026 | 10 a.m.–1:30 p.m.").
async function bbg(): Promise<Ev[]> {
  const r = await get("https://www.bbg.org/calendar")
  if (!r) return []
  const out: Ev[] = [], seen = new Set<string>()
  for (const item of (await r.text()).split(/<li\s+data-category/).slice(1)) {
    const href = item.match(/<a\s+href="(\/[^"]+)"/)?.[1], title = item.match(/<h3[^>]*>([\s\S]*?)<\/h3>/)?.[1]
    const when = text(item.match(/class="event-date"\s*>([\s\S]*?)<\/p>/)?.[1] || "").replace(/\s+/g, " ").trim()
    const d = when.match(/([A-Z][a-z]+) (\d{1,2}), (\d{4})/)
    if (!href || !title || !d || !MONTH_EN[d[1].slice(0, 3).toLowerCase()]) continue
    const t = when.match(/\|\s*(\d{1,2})(?::(\d{2}))?\s*(a\.m\.|p\.m\.|noon)/i)
    const hour = t ? (/noon/i.test(t[3]) ? 12 : (Number(t[1]) % 12) + (/p\.m\./i.test(t[3]) ? 12 : 0)) : 10
    const url = `https://www.bbg.org${href}`, key = `${url}|${d[0]}`
    if (seen.has(key)) continue
    seen.add(key)
    const tag = text(item.match(/class="event-tag">([\s\S]*?)<\/span>/)?.[1] || "").trim()
    const blurb = text(item.match(/class="event-blurb">([\s\S]*?)<span class="learnmore"/)?.[1] || "").replace(/\s+/g, " ").trim()
    out.push({ url, name: text(title).replace(/\s+/g, " ").trim(), start_date: zoned(Number(d[3]), MONTH_EN[d[1].slice(0, 3).toLowerCase()], Number(d[2]), `${hour}:${t?.[2] || "00"}`, "America/New_York"),
      venue: "Brooklyn Botanic Garden", city: "Brooklyn", country: "US", description: [tag, when.split("|").slice(1).join("·").trim(), blurb].filter(Boolean).join(". ").slice(0, 400) })
  }
  return out.filter(e => Date.parse(e.start_date) > Date.now() - 6 * 3600000)
}

// Flea and craft markets (loppemarkeder, kræmmermarkeder) from loppemarkeder.nu: schema.org events on
// its front page and its Copenhagen pages. The city comes from the postcode in the address (under 2800 is
// Copenhagen and Frederiksberg) or the town after it, so "markets in cph today" finds Brønshøj Torv.
const CPH_AREAS = /\b(københavn|kobenhavn|copenhagen|kbh|brønshøj|vanløse|valby|nørrebro|vesterbro|østerbro|amager|islands brygge|nordhavn|sydhavn|christianshavn|frederiksberg|indre by|bispebjerg|husum|nordvest|ørestad|refshaleøen|kødbyen|sundby|kastrup|hvidovre|rødovre|tårnby)\b/i
async function loppemarkeder(): Promise<Ev[]> {
  const out: Ev[] = [], seen = new Set<string>()
  for (const page of ["/", "/loppemarkeder-koebenhavn/", "/loppemarkeder-koebenhavns-omegn/", "/loppemarked-vesterbro/"]) {
    const r = await get(`https://www.loppemarkeder.nu${page}`)
    if (r) for (const e of extractEvents(await r.text(), `https://www.loppemarkeder.nu${page}`) as any[]) {
      if (!e?.url || seen.has(`${e.url}|${e.start_date}`)) continue
      seen.add(`${e.url}|${e.start_date}`)
      const where = String(e.venue || ""), pc = where.match(/\b(\d{4})\s+([A-ZÆØÅ][\wæøåÆØÅ .-]+?)(?:,|$)/)
      const all = `${text(e.name)} ${where} ${text(e.description || "")}`
      const city = pc ? (Number(pc[1]) < 2800 ? "Copenhagen" : pc[2].trim()) : CPH_AREAS.test(all) ? "Copenhagen" : (text(e.name).split(/\s+[–-]\s+/)[1] || "Denmark")
      out.push({ url: e.url, name: text(e.name), start_date: e.start_date, venue: where || text(e.name), city, country: "DK",
        price: e.price ?? null, currency: e.currency ?? null, description: ["Flea / craft market", e.description ? text(e.description) : ""].filter(Boolean).join(". ").slice(0, 400) })
    }
    await pause(1000)
  }
  return out
}

export const READERS: Record<string, () => Promise<Ev[]>> = {
  "loppemarkeder.nu": loppemarkeder,
  "bbg.org": bbg,
  "tribe-events": tribe,
  "libcal.com": libcal,
  "lapl.org": lapl,
  "aegpresents.com": aeg,
  "mercuryeastpresents.com": () => ticketWeb(["https://mercuryeastpresents.com/boweryballroom", "https://mercuryeastpresents.com/mercurylounge", "https://mercuryeastpresents.com/"]),
  "irvingplaza.com": () => schemaEvents([{ url: "https://www.irvingplaza.com", city: "New York", country: "US" }]),
  // Live Nation's US venue sites publish their next ~25 shows as schema.org events.
  "livenation.com": () => schemaEvents([
    ["houseofblues.com/boston", "Boston"], ["houseofblues.com/chicago", "Chicago"], ["houseofblues.com/anaheim", "Anaheim"], ["houseofblues.com/lasvegas", "Las Vegas"],
    ["houseofblues.com/dallas", "Dallas"], ["houseofblues.com/houston", "Houston"], ["houseofblues.com/neworleans", "New Orleans"], ["houseofblues.com/sandiego", "San Diego"],
    ["houseofblues.com/orlando", "Orlando"], ["thefillmore.com", "San Francisco"], ["hollywoodpalladium.com", "Los Angeles"], ["fillmoresilverspring.com", "Silver Spring"],
    ["fillmoreauditorium.org", "Denver"], ["fillmoreminneapolis.com", "Minneapolis"], ["thegramercytheatre.com", "New York"]
  ].map(([path, city]) => ({ url: `https://www.${path}`, city, country: "US" }))),
  "thebellhouseny.com": () => schemaEvents([{ url: "https://www.thebellhouseny.com/calendar", city: "Brooklyn", country: "US" }]),
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
