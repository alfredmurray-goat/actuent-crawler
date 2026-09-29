import { SUPABASE_URL, SUPABASE_HEADERS } from "./shared"
import { fetchPublic, isPublicHost } from "./safe-fetch"
import { USER_AGENT } from "./robots"
import { cleanName, cleanTitles } from "./convert"
import { launchWeekPause } from "./quiet"

// Weekly index quality pass (list_eleven.sql), in four steps:
//   1. "Did you mean" vocabulary: rebuilt from site names, titles, keywords and categories.
//   2. Mirrors and copies: domains with identical homepage content are flagged as duplicates of the
//      best-known one (status=duplicate, duplicate_of), which keeps them out of search.
//   3. Summary audit: sites whose summary is empty, too short, boilerplate or not in English are
//      sent back to the backlog (conversion=heuristic), so reconvert gives them a fresh LLM summary.
//   4. Action links: direct links on actions (book, pricing, contact…) are checked; dead ones
//      (404/410, or the host is gone) are removed from the action, most popular sites first.
// DRY_RUN=1 reports without writing.

const DRY = !!process.env.DRY_RUN
const TIME_BUDGET_MS = parseInt(process.env.TIME_BUDGET_MIN || "90") * 60000
const LINK_CHECKS = parseInt(process.env.LINK_CHECKS || "3000")
const started = Date.now()
if (!process.env.SUPABASE_SERVICE_KEY) { console.error("Missing SUPABASE_SERVICE_KEY"); process.exit(1) }

const JSON_HEADERS = { ...SUPABASE_HEADERS, "Content-Type": "application/json", "Prefer": "return=minimal" }
async function patch(domain: string, body: object) {
  if (DRY) return
  await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?domain=eq.${encodeURIComponent(domain)}`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(body) }).catch(() => {})
}

async function vocabulary() {
  if (DRY) { console.log("1. vocabulary: skipped (dry run)"); return }
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/build_search_vocab`, { method: "POST", headers: { ...SUPABASE_HEADERS, "Content-Type": "application/json" }, body: "{}" })
  console.log(`1. vocabulary: ${r.ok ? `${await r.json()} words` : `failed ${r.status} ${(await r.text()).slice(0, 200)}`}`)
}

async function duplicates() {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/content_duplicates`, { method: "POST", headers: { ...SUPABASE_HEADERS, "Content-Type": "application/json" }, body: JSON.stringify({ max_groups: 1000 }) })
  if (!r.ok) { console.log(`2. duplicates: failed ${r.status} ${(await r.text()).slice(0, 200)}`); return }
  const groups: { content_hash: string, domains: string[] }[] = await r.json()
  let flagged = 0
  for (const g of groups) {
    const [keep, ...copies] = g.domains
    for (const d of copies) { await patch(d, { status: "duplicate", duplicate_of: keep }); flagged++ }
    if (flagged <= 10) console.log(`   ${copies.join(", ")} → copies of ${keep}`)
  }
  console.log(`2. duplicates: ${groups.length} groups, ${flagged} copies ${DRY ? "would be " : ""}flagged`)
}

const BOILERPLATE = /cookie|javascript|enable js|skip to|accept all|sign in to|log in to|404|not found|access denied|captcha|just a moment|checking your browser/i
function badSummary(text: string, language?: string): string | null {
  const t = String(text || "").trim()
  if (!t) return "empty"
  if (/^Website at /.test(t) || t.length < 40) return "too short"
  if (BOILERPLATE.test(t.slice(0, 120))) return "boilerplate"
  const letters = t.replace(/[^\p{L}]/gu, "")
  const latin = t.replace(/[^a-zA-Z]/g, "")
  if (letters.length > 20 && latin.length / letters.length < 0.6) return "not English"
  if (language === "en" && / (und|der|die|les|des|et|el|los|het|och|og) /i.test(` ${t} `) && !/ (the|and|of|for|with) /i.test(` ${t} `)) return "not English"
  return null
}

async function summaries() {
  let last = "", seen = 0, sent = 0
  const reasons: Record<string, number> = {}
  while (Date.now() - started < TIME_BUDGET_MS / 4) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?select=domain,pages,language,conversion&conversion=eq.llm&status=is.null&owner_key=is.null&domain=gt.${encodeURIComponent(last)}&order=domain.asc&limit=1000`, { headers: SUPABASE_HEADERS })
    if (!r.ok) { console.log(`3. summaries: ${r.status}`); return }
    const rows: any[] = await r.json()
    if (!rows.length) break
    for (const row of rows) {
      seen++
      const home = row.pages?.["/"]?.content ?? Object.values(row.pages || {})[0] as any
      const why = badSummary(typeof home === "string" ? home : home?.content, row.language)
      if (!why) continue
      reasons[why] = (reasons[why] || 0) + 1
      sent++
      // Back into the backlog: reconvert upgrades "heuristic" entries whenever there's LLM quota.
      await patch(row.domain, { conversion: "heuristic" })
    }
    last = rows[rows.length - 1].domain
  }
  console.log(`3. summaries: ${seen} AI-written summaries checked, ${sent} ${DRY ? "would be " : ""}sent back for a new one ${JSON.stringify(reasons)}`)
}

async function linkAlive(url: string): Promise<boolean | null> {
  let u: URL
  try { u = new URL(url) } catch { return false }
  if (!/^https?:$/.test(u.protocol)) return null
  if (!await isPublicHost(u.hostname)) return false
  const r = await fetchPublic(url, { method: "GET", headers: { "User-Agent": USER_AGENT, "Accept": "text/html" }, signal: AbortSignal.timeout(8000) }).catch(() => null)
  if (!r) return null // network trouble: don't judge
  if (r.status === 404 || r.status === 410) return false
  return true
}

async function actionLinks() {
  // Popular sites first; only actions with a direct link are checked.
  let offset = 0, checked = 0, removed = 0, sites = 0
  while (checked < LINK_CHECKS && Date.now() - started < TIME_BUDGET_MS) {
    const page = await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?select=domain,actions&status=is.null&owner_key=is.null&native=is.false&actions=neq.%5B%5D&order=popularity_rank.asc.nullslast&offset=${offset}&limit=500`, { headers: SUPABASE_HEADERS })
    if (!page.ok) break
    const rows: any[] = await page.json()
    if (!rows.length) break
    offset += rows.length
    for (const row of rows) {
      const actions: any[] = Array.isArray(row.actions) ? row.actions : []
      if (!actions.some(a => typeof a?.url === "string")) continue
      sites++
      let changed = false
      const next = []
      for (const a of actions) {
        if (typeof a?.url !== "string") { next.push(a); continue }
        checked++
        const alive = await linkAlive(a.url)
        if (alive === false) { const { url, ...rest } = a; next.push(rest); changed = true; removed++; if (removed <= 10) console.log(`   dead link removed: ${row.domain} ${a.id} ${url}`) }
        else next.push(a)
      }
      if (changed) await patch(row.domain, { actions: next })
      if (checked >= LINK_CHECKS || Date.now() - started > TIME_BUDGET_MS) break
    }
  }
  console.log(`4. action links: ${checked} links on ${sites} sites checked, ${removed} dead ${DRY ? "would be " : ""}removed`)
}

// 5. Names and titles ("Home - Nike" → "Nike"), and sites labelled English whose summary isn't.
async function namesAndLanguage() {
  let last = "", seen = 0, renamed = 0, relabelled = 0
  while (Date.now() - started < TIME_BUDGET_MS * 0.8) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?select=domain,name,pages,language,conversion&status=is.null&owner_key=is.null&native=is.false&domain=gt.${encodeURIComponent(last)}&order=domain.asc&limit=1000`, { headers: SUPABASE_HEADERS })
    if (!r.ok) { console.log(`5. names: ${r.status}`); return }
    const rows: any[] = await r.json()
    if (!rows.length) break
    for (const row of rows) {
      seen++
      const name = cleanName(row.name, row.domain)
      const pages = cleanTitles(row.pages || {})
      const changed = name !== row.name || JSON.stringify(pages) !== JSON.stringify(row.pages || {})
      const home = String(row.pages?.["/"]?.content || "")
      const notEnglish = row.language === "en" && badSummary(home, "en") === "not English"
      if (changed || notEnglish) {
        await patch(row.domain, { ...(changed ? { name, pages } : {}), ...(notEnglish ? { language: null, conversion: "heuristic" } : {}) })
        if (changed) renamed++
        if (notEnglish) relabelled++
      }
    }
    last = rows[rows.length - 1].domain
  }
  console.log(`5. names: ${seen} sites checked, ${renamed} names/titles ${DRY ? "would be " : ""}cleaned, ${relabelled} marked for a new English summary`)
}

// 6. Popular sites not refreshed for 180 days go into the crawl queue (crawl_queue.ts, every 30 min).
async function staleSites() {
  const cutoff = encodeURIComponent(new Date(Date.now() - 180 * 86400000).toISOString())
  const r = await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?select=domain&status=is.null&owner_key=is.null&popularity_rank=lte.50000&updated_at=lt.${cutoff}&order=popularity_rank.asc&limit=500`, { headers: SUPABASE_HEADERS })
  const rows: any[] = r.ok ? await r.json() : []
  if (!DRY) for (const { domain } of rows) {
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/queue_crawl`, { method: "POST", headers: { ...SUPABASE_HEADERS, "Content-Type": "application/json" }, body: JSON.stringify({ d: domain }) }).catch(() => {})
  }
  console.log(`6. stale popular sites: ${rows.length} ${DRY ? "would be " : ""}queued for a refresh`)
}

async function main() {
  if (launchWeekPause()) return
  await vocabulary()
  await duplicates()
  await summaries()
  await namesAndLanguage()
  await staleSites()
  await actionLinks()
}

main().catch(e => { console.error(e); process.exit(1) })
