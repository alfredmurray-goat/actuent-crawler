import { SUPABASE_URL, SUPABASE_HEADERS, fetchNative, scrapeJina, toLAWP, saveSite, contentHash, robotsAllows } from "./shared"


// Refresh by importance: how often agents actually got each site in search results over the last
// 30 days (the last 7 count double). The more in demand a site is, the sooner it's refreshed:
//   30+ appearances → after 2 days · 10+ → 7 days · 3+ → 21 days. Most stale-for-its-demand first.
const MAX_SITES = parseInt(process.env.RECRAWL_MAX || "400")
const TIME_BUDGET_MS = parseInt(process.env.TIME_BUDGET_MIN || "60") * 60000

async function demand(): Promise<Map<string, number>> {
  const since = new Date(Date.now() - 30 * 86400000).toISOString()
  const week = Date.now() - 7 * 86400000
  const counts = new Map<string, number>()
  // Supabase returns at most 1000 rows per request.
  for (let offset = 0; offset < 50000; offset += 1000) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/searches?select=domains,created_at&created_at=gte.${encodeURIComponent(since)}&order=created_at.desc&limit=1000&offset=${offset}`, { headers: SUPABASE_HEADERS })
    const rows: any[] = res.ok ? await res.json() : []
    for (const s of rows) {
      const weight = Date.parse(s.created_at) >= week ? 2 : 1
      for (const d of (s.domains || []).slice(0, 5)) counts.set(d, (counts.get(d) || 0) + weight)
    }
    if (rows.length < 1000) break
  }
  return counts
}

function maxAgeDays(score: number): number | null {
  return score >= 30 ? 2 : score >= 10 ? 7 : score >= 3 ? 21 : null
}

async function queue(): Promise<{ domain: string, score: number, overdue: number }[]> {
  const scores = await demand()
  const wanted = [...scores.entries()].filter(([, n]) => maxAgeDays(n) !== null)
  const out: { domain: string, score: number, overdue: number }[] = []
  for (let i = 0; i < wanted.length; i += 100) {
    const chunk = wanted.slice(i, i + 100)
    const list = encodeURIComponent(chunk.map(([d]) => `"${d}"`).join(","))
    const res = await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?select=domain,updated_at&domain=in.(${list})`, { headers: SUPABASE_HEADERS })
    const rows: any[] = res.ok ? await res.json() : []
    const updated = new Map(rows.map(r => [r.domain, Date.parse(r.updated_at)]))
    for (const [domain, score] of chunk) {
      const ageDays = updated.has(domain) ? (Date.now() - updated.get(domain)!) / 86400000 : Infinity
      const overdue = ageDays / maxAgeDays(score)!
      if (overdue >= 1) out.push({ domain, score, overdue })
    }
  }
  // Most overdue relative to demand first; ties go to the more popular site.
  return out.sort((a, b) => (b.overdue === Infinity ? 1e9 : b.overdue) * b.score - (a.overdue === Infinity ? 1e9 : a.overdue) * a.score)
}

async function recrawlSite(domain: string): Promise<void> {
  const native = await fetchNative(domain)
  if (native) { await saveSite(native); console.log(`native: ${domain}`); return }

  if (!await robotsAllows(domain, "/")) { console.log(`robots.txt disallows: ${domain}`); return }
  const content = await scrapeJina(domain)
  if (!content) { console.log(`blocked: ${domain}`); return }

  // Unchanged content: keep the existing LAWP and spend no LLM tokens.
  const hash = contentHash(content)
  const existing = await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?select=content_hash,owner_key&domain=eq.${encodeURIComponent(domain)}`, { headers: SUPABASE_HEADERS })
  const row = existing.ok ? (await existing.json())?.[0] : null
  if (row?.owner_key) { console.log(`claimed by owner, not overwritten: ${domain}`); return }
  if (row?.content_hash === hash) { console.log(`unchanged: ${domain}`); return }

  const lawp = await toLAWP(domain, content)
  // Never overwrite a good LAWP with a minimal one.
  if (!Array.isArray(lawp.actions) || lawp.actions.length === 0) { console.log(`no usable LAWP, kept existing: ${domain}`); return }
  await saveSite(lawp, hash)
  console.log(`recrawled: ${domain}`)
}

async function main() {
  const start = Date.now()
  const todo = await queue()
  console.log(`${todo.length} in-demand sites are due a refresh; doing up to ${MAX_SITES}`)
  let done = 0
  for (const { domain, score } of todo.slice(0, MAX_SITES)) {
    if (Date.now() - start > TIME_BUDGET_MS) { console.log("Time budget used"); break }
    try { await recrawlSite(domain); done++ } catch (e) { console.log(`error: ${domain}: ${e}`) }
    if (done % 50 === 0 && done) console.log(`${done} refreshed (last demand score ${score})`)
  }
  console.log(`Done: ${done} sites refreshed`)
}

main()
