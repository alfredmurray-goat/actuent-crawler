import { SUPABASE_URL, SUPABASE_HEADERS } from "./shared"

// Music genres for concerts, so "jazz in Copenhagen tonight" or "techno this weekend" finds them and
// assistants can say what kind of show it is. The genre goes at the end of the event's description
// ("Genre: indie pop, alternative rock (pop, rock)."), so no new column is needed and the events
// search, which already looks in descriptions, finds it.
//   1. The event's own words ("jazzkoncert", "DJ set", "symfoni").
//   2. Otherwise Wikidata's genres (P136) for the artist, only for musicians and bands, and only when
//      the name matches exactly (so "Arlo" isn't Arlo Guthrie). Genres found earlier are reused.

type Ev = { url: string, name: string, description?: string | null }

// Broad families: what people actually type. Checked against the genre names and the event's text.
const FAMILIES: [string, RegExp][] = [
  ["metal", /\b(metal|metalcore|deathcore|grindcore|doom|thrash|djent)\b/i],
  ["punk", /\b(punk|hardcore|emo|post-hardcore)\b/i],
  ["rock", /\b(rock|grunge|shoegaze|post-rock|garage)\b/i],
  ["indie", /\bindie\b/i],
  ["pop", /\b(pop|k-pop|synth-pop|dance-pop|teen pop)\b/i],
  ["hip hop", /\b(hip[- ]?hop|rap|trap|drill|grime)\b/i],
  ["soul", /\b(soul|r&b|rhythm and blues|funk|neo soul|gospel)\b/i],
  ["electronic", /\b(electronic|techno|house music|deep house|tech house|acid house|edm|trance|dubstep|drum and bass|drum & bass|dnb|ambient|electronica|dj[- ]?set|club night|rave)\b/i],
  ["jazz", /\b(jazz|bebop|swing|big band|jazzkoncert)\b/i],
  ["blues", /\bblues\b/i],
  ["classical", /\b(classical|klassisk|symphon(y|ic)|symfoni|orchestra|orkester|opera|chamber music|kammermusik|baroque|barok|choir|kor|pianist|string quartet|strygekvartet)\b/i],
  ["folk", /\b(folk|singer-songwriter|americana|bluegrass|visesang)\b/i],
  ["country", /\bcountry\b/i],
  ["reggae", /\b(reggae|dancehall|ska|dub)\b/i],
  ["latin", /\b(latin|salsa|reggaeton|bachata|cumbia|flamenco|tango)\b/i],
  ["world", /\b(afrobeats?|world music|balkan|klezmer)\b/i]
]
const families = (text: string) => FAMILIES.filter(([, re]) => re.test(text)).map(([f]) => f)

// The artist from an event name: "Foster The People with Goth Babe", "DJ Shadow + Prince Paul",
// "Gnags – 40 års jubilæum", "SOLD OUT: Overmono".
export function artistOf(name: string): string {
  return name.replace(/^(sold out|udsolgt|cancelled|aflyst|new date|nyt tidspunkt|postponed)\s*[:|-]\s*/i, "")
    .split(/\s+(?:with|w\/|feat\.?|ft\.?|featuring|support:?|\+|&|og|x|vs\.?|presents)\s+|\s+[–—|-]\s+|:\s+|\s*\(/i)[0]
    .replace(/["“”]/g, "").trim()
}

const UA = "ActuentBot/1.0 (https://docs.actuent.ai/bot; support@localilabs.com)"
const looked = new Map<string, string[]>()
async function wikidataGenres(artist: string): Promise<string[]> {
  const key = artist.toLowerCase()
  if (looked.has(key)) return looked.get(key)!
  const safe = artist.replace(/["\\]/g, "")
  const q = `SELECT ?item ?l ?gl WHERE {
    SERVICE wikibase:mwapi { bd:serviceParam wikibase:endpoint "www.wikidata.org"; wikibase:api "EntitySearch"; mwapi:search "${safe}"; mwapi:language "en". ?item wikibase:apiOutputItem mwapi:item. ?num wikibase:apiOrdinal true. }
    FILTER(?num < 4)
    { ?item wdt:P31/wdt:P279* wd:Q215380 } UNION { ?item wdt:P106/wdt:P279* wd:Q639669 } UNION { ?item wdt:P106 wd:Q130857 }
    ?item rdfs:label|skos:altLabel ?l. FILTER(lang(?l) IN ("en", "da", "sv", "de", "mul"))
    ?item wdt:P136 ?g. ?g rdfs:label ?gl. FILTER(lang(?gl) = "en")
  } LIMIT 60`
  let genres: string[] = []
  try {
    const r = await fetch(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(q)}`, { headers: { "User-Agent": UA, "Accept": "application/sparql-results+json" }, signal: AbortSignal.timeout(20000) })
    const rows: any[] = r.ok ? (await r.json()).results.bindings : []
    // Only an item whose name (or alias) is exactly the artist's.
    const exact = rows.filter(b => String(b.l.value).toLowerCase() === key)
    const item = exact[0]?.item.value
    genres = [...new Set(exact.filter(b => b.item.value === item).map(b => String(b.gl.value).replace(/ music$/, "")))].slice(0, 3)
  } catch {}
  looked.set(key, genres)
  return genres
}

// Genres already worked out for these events (earlier runs), by URL.
async function known(urls: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (let i = 0; i < urls.length; i += 80) {
    const list = urls.slice(i, i + 80).map(u => `"${u.replace(/"/g, "")}"`).join(",")
    const r = await fetch(`${SUPABASE_URL}/rest/v1/lawp_events?select=url,description&description=ilike.*Genre:*&url=in.(${encodeURIComponent(list)})`, { headers: SUPABASE_HEADERS }).catch(() => null)
    for (const row of r?.ok ? await r.json() : []) {
      const g = String(row.description || "").match(/Genre: ([^.]+)\./)?.[1]
      if (g) out.set(row.url, g)
    }
  }
  return out
}

// Adds "Genre: …." to concerts' descriptions. maxLookups caps Wikidata calls per run (one a ~0.3 s).
export async function addGenres<T extends Ev>(events: T[], maxLookups = 400): Promise<T[]> {
  const before = await known(events.map(e => e.url)).catch(() => new Map<string, string>())
  let lookups = 0
  for (const e of events) {
    if (/Genre: /.test(e.description || "")) continue
    let genre = before.get(e.url) || ""
    if (!genre) {
      const own = families(`${e.name} ${e.description || ""}`)
      let names: string[] = []
      const artist = artistOf(e.name)
      if (artist.length >= 2 && artist.length <= 60) {
        if (looked.has(artist.toLowerCase())) names = looked.get(artist.toLowerCase())!
        else if (lookups < maxLookups) { lookups++; await new Promise(r => setTimeout(r, 300)); names = await wikidataGenres(artist) }
      }
      // Wikidata's genres when it knows the artist (a tour called "House of Cards" isn't house music).
      const fam = names.length ? families(names.join(" ")) : own
      if (!names.length && !fam.length) continue
      genre = names.length ? `${names.join(", ")}${fam.length ? ` (${fam.join(", ")})` : ""}` : fam.join(", ")
    }
    e.description = `${String(e.description || "").trim()} Genre: ${genre}.`.trim()
  }
  return events
}

// Daily: every upcoming concert in lawp_events without a genre (venues found by the general venue
// crawl, not only the music readers). Only events that look like music, so "rock climbing" stays out.
const MUSICAL = /\b(concerts?|koncert(er)?|konsert(er)?|konzert(e)?|live music|livemusik|gig|tour|band|dj|orchestra|orkester|symphony|symfoni|jazz|quartet|kvartet|choir|kor|album release|release party|in concert|live)\b/i
async function genresForAll() {
  const now = encodeURIComponent(new Date().toISOString()), soon = encodeURIComponent(new Date(Date.now() + 45 * 86400000).toISOString())
  const r = await fetch(`${SUPABASE_URL}/rest/v1/lawp_events?select=url,name,description,venue&start_date=gte.${now}&start_date=lte.${soon}&or=(description.is.null,description.not.ilike.*Genre:*)&order=start_date.asc&limit=5000`, { headers: SUPABASE_HEADERS })
  const rows: (Ev & { venue?: string })[] = r.ok ? await r.json() : []
  const music = rows.filter(e => MUSICAL.test(`${e.name} ${e.description || ""} ${e.venue || ""}`))
  console.log(`${rows.length} upcoming events without a genre, ${music.length} look like music`)
  const before = new Map(music.map(e => [e.url, e.description || ""]))
  await addGenres(music, Number(process.env.MAX_LOOKUPS || 500))
  let saved = 0
  for (const e of music) {
    if (e.description === before.get(e.url)) continue
    const u = await fetch(`${SUPABASE_URL}/rest/v1/lawp_events?url=eq.${encodeURIComponent(e.url)}`, { method: "PATCH", headers: { ...SUPABASE_HEADERS, "Content-Type": "application/json", "Prefer": "return=minimal" }, body: JSON.stringify({ description: e.description }) }).catch(() => null)
    if (u?.ok) saved++
  }
  console.log(`${saved} concerts got a genre`)
}

if (process.argv[1]?.endsWith("genres.ts")) genresForAll().catch(e => { console.error(e); process.exit(1) })
