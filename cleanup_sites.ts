// Flags parked domains ("this domain is for sale") and duplicates (brand.co.uk redirecting to an
// indexed brand.com) so they're left out of search and directories. Flags only — nothing is
// deleted, and updated_at is never changed, so the reconvert job isn't disturbed.
// Claimed and native sites are never flagged. Needs list_four.sql.

const SUPABASE_URL = "https://bcmwypjrahtxogytsvuc.supabase.co"
const KEY = process.env.SUPABASE_SERVICE_KEY!
const HEADERS = { "apikey": KEY, "Authorization": `Bearer ${KEY}` }
const USER_AGENT = "Mozilla/5.0 (compatible; Actuent/1.0; +https://docs.actuent.ai/bot)"
const TIME_BUDGET_MS = parseInt(process.env.TIME_BUDGET_MIN || "60") * 60000
const CONCURRENCY = 10

if (!KEY) { console.error("Missing SUPABASE_SERVICE_KEY"); process.exit(1) }

// A malformed response can trip Node's fetch parser outside any try/catch; keep going.
process.on("uncaughtException", (e: any) => {
  if (e?.code === "ERR_ASSERTION" && /undici/.test(String(e?.stack))) return
  console.error(e); process.exit(1)
})

export const PARKED = /\b(this domain (name )?(is|may be) for sale|buy this domain|domain (is )?for sale|this domain is parked|parked (free|domain|by)|sedoparking|sedo\.com|dan\.com|afternic|hugedomains|undeveloped\.com|domain has expired|this domain has been registered|future home of something|is available for purchase|make an offer on this domain)\b/i

const bare = (host: string) => host.toLowerCase().replace(/^www\./, "")

async function redirectTarget(domain: string): Promise<string | null> {
  for (const url of [`https://${domain}/`, `http://${domain}/`]) {
    try {
      const r = await fetch(url, { redirect: "manual", headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(7000) })
      if (r.status < 300 || r.status >= 400) return null
      const location = r.headers.get("location")
      if (!location) return null
      const host = bare(new URL(location, url).hostname)
      const site = bare(domain)
      // Same site (www, https, a path) or a subdomain of it isn't a duplicate.
      if (host === site || host.endsWith(`.${site}`) || site.endsWith(`.${host}`)) return null
      return host
    } catch { continue }
  }
  return null
}

async function indexed(domains: string[]): Promise<Set<string>> {
  if (!domains.length) return new Set()
  const list = encodeURIComponent(domains.flatMap(d => [`"${d}"`, `"www.${d}"`]).join(","))
  const r = await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?select=domain&domain=in.(${list})`, { headers: HEADERS })
  return new Set(r.ok ? (await r.json()).map((x: any) => bare(x.domain)) : [])
}

async function main() {
  const start = Date.now()
  let checked = 0, parked = 0, duplicates = 0
  while (Date.now() - start < TIME_BUDGET_MS) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?select=domain,name,pages,owner_key,native&checked_at=is.null&order=domain.asc&limit=300`, { headers: HEADERS })
    if (!r.ok) { console.log(`Could not load sites: ${r.status} ${await r.text()}`); break }
    const rows: any[] = await r.json()
    if (!rows.length) { console.log("Every site has been checked"); break }

    const results: { domain: string, status: string | null, duplicate_of: string | null }[] = []
    let index = 0
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (index < rows.length) {
        const row = rows[index++]
        let status: string | null = null, duplicateOf: string | null = null
        if (!row.owner_key && !row.native) {
          const text = `${row.name || ""} ${Object.values(row.pages || {}).map((p: any) => `${p?.title || ""} ${p?.content || ""}`).join(" ")}`
          if (PARKED.test(text)) status = "parked"
          else {
            const target = await redirectTarget(row.domain)
            if (target) { status = "duplicate?"; duplicateOf = target }
          }
        }
        results.push({ domain: row.domain, status, duplicate_of: duplicateOf })
      }
    }))
    // A redirect only makes a duplicate when the target is indexed too.
    const targets = await indexed([...new Set(results.filter(x => x.status === "duplicate?").map(x => x.duplicate_of!))])
    for (const x of results) if (x.status === "duplicate?") { if (targets.has(x.duplicate_of!)) x.status = "duplicate"; else { x.status = null; x.duplicate_of = null } }

    const now = new Date().toISOString()
    // One PATCH per distinct outcome; flagged rows individually (they carry duplicate_of).
    const clean = results.filter(x => !x.status).map(x => x.domain)
    for (let i = 0; i < clean.length; i += 100) {
      const list = encodeURIComponent(clean.slice(i, i + 100).map(d => `"${d}"`).join(","))
      await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?domain=in.(${list})`, { method: "PATCH", headers: { ...HEADERS, "Content-Type": "application/json", "Prefer": "return=minimal" }, body: JSON.stringify({ checked_at: now }) })
    }
    for (const x of results.filter(x => x.status)) {
      await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?domain=eq.${encodeURIComponent(x.domain)}`, { method: "PATCH", headers: { ...HEADERS, "Content-Type": "application/json", "Prefer": "return=minimal" }, body: JSON.stringify({ status: x.status, duplicate_of: x.duplicate_of, checked_at: now }) })
      if (x.status === "parked") parked++; else duplicates++
      console.log(`${x.status!.padEnd(9)} ${x.domain}${x.duplicate_of ? ` → ${x.duplicate_of}` : ""}`)
    }
    checked += rows.length
  }
  console.log(`Done in ${Math.round((Date.now() - start) / 60000)} min: ${checked} checked, ${parked} parked, ${duplicates} duplicates`)
}

main().catch(e => { console.error(e); process.exit(1) })
