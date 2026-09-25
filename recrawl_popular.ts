import { complete } from "./llm"

const SUPABASE_URL = "https://bcmwypjrahtxogytsvuc.supabase.co"
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

async function scrapeWithJina(domain: string): Promise<string | null> {
  try {
    const res = await fetch(`https://r.jina.ai/https://${domain}`, {
      headers: { "Accept": "text/plain" },
      signal: AbortSignal.timeout(15000)
    })
    if (!res.ok) return null
    return (await res.text()).slice(0, 3000)
  } catch { return null }
}

async function recrawlSite(domain: string): Promise<void> {
  const content = await scrapeWithJina(domain)
  if (!content) { console.log(`blocked: ${domain}`); return }

  const raw = await complete(`Convert to LAWP JSON:\n\nDomain: ${domain}\nContent: ${content}\n\nReturn ONLY: {"domain":"${domain}","name":"Name","pages":{"/":{"title":"T","content":"C"}},"actions":[{"id":"i","name":"N","description":"D","intent":["k1","k2","k3"],"input":{"type":"text","required":false}}]}`)
  if (!raw) { console.log(`no model available, kept existing LAWP: ${domain}`); return }

  let lawp: any = null
  try { lawp = JSON.parse(raw) } catch {
    const match = raw.match(/\{[\s\S]*\}/)
    if (match) { try { lawp = JSON.parse(match[0]) } catch {} }
  }
  // Never overwrite a good LAWP with a malformed one.
  if (!lawp?.pages || typeof lawp.pages !== "object" || Object.keys(lawp.pages).length === 0) {
    console.log(`bad LAWP, kept existing: ${domain}`)
    return
  }

  await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?domain=eq.${domain}`, {
    method: "PATCH",
    headers: {
      "apikey": SUPABASE_SERVICE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ name: lawp.name, pages: lawp.pages, actions: lawp.actions, updated_at: new Date().toISOString() })
  })
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