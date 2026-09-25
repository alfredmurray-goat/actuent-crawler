import { SUPABASE_URL, SUPABASE_HEADERS, fetchNative, scrapeJina, toLAWP, saveSite, contentHash, robotsAllows } from "./shared"

const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!

async function getPopularDomains(): Promise<string[]> {
  const since = new Date(Date.now() - 7 * 86400000).toISOString()
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/searches?select=domains&created_at=gte.${since}`,
    { headers: { "apikey": SUPABASE_SERVICE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}` } }
  )
  const searches = await res.json()
  const counts: Record<string, number> = {}
  for (const s of searches) {
    for (const d of (s.domains || [])) counts[d] = (counts[d] || 0) + 1
  }
  return Object.entries(counts)
    .filter(([_, count]) => count >= 10)
    .sort((a, b) => b[1] - a[1])
    .map(([domain]) => domain)
}

async function needsRecrawl(domain: string): Promise<boolean> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/lawp_sites?domain=eq.${domain}&select=updated_at`,
    { headers: { "apikey": SUPABASE_SERVICE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}` } }
  )
  const data = await res.json()
  if (!data?.[0]) return true
  const updatedAt = new Date(data[0].updated_at).getTime()
  return Date.now() - updatedAt > 7 * 86400000
}


async function recrawlSite(domain: string): Promise<void> {
  const native = await fetchNative(domain)
  if (native) { await saveSite(native); console.log(`native: ${domain}`); return }

  if (!await robotsAllows(domain, "/")) { console.log(`robots.txt disallows: ${domain}`); return }
  const content = await scrapeJina(domain)
  if (!content) { console.log(`blocked: ${domain}`); return }

  // Unchanged content: keep the existing LAWP and spend no LLM tokens.
  const hash = contentHash(content)
  const existing = await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?select=content_hash&domain=eq.${encodeURIComponent(domain)}`, { headers: SUPABASE_HEADERS })
  if (existing.ok && (await existing.json())?.[0]?.content_hash === hash) { console.log(`unchanged: ${domain}`); return }

  const lawp = await toLAWP(domain, content)
  // Never overwrite a good LAWP with a minimal one.
  if (!Array.isArray(lawp.actions) || lawp.actions.length === 0) { console.log(`no usable LAWP, kept existing: ${domain}`); return }
  await saveSite(lawp, hash)
  console.log(`recrawled: ${domain}`)
}

async function main() {
  const popular = await getPopularDomains()
  console.log(`Found ${popular.length} popular domains`)

  for (const domain of popular) {
    const stale = await needsRecrawl(domain)
    if (!stale) { console.log(`fresh: ${domain}`); continue }
    try { await recrawlSite(domain) } catch (e) { console.log(`error: ${domain}: ${e}`) }
  }
  console.log("Done")
}

main()