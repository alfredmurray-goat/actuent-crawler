import { SUPABASE_URL, SUPABASE_HEADERS, fetchNative, fetchSite, saveSite, saveEvents, contentHash, robotsAllows } from "./shared"
import { searchNeedsTheDatabase, tooFullToGrow } from "./quiet"
import { INFRASTRUCTURE } from "./heuristic"
import { extractEvents } from "./business"
import { fetchLlmsTxt } from "./llmstxt"
import { convertSite, domainGone, isParkedOrError, notASite } from "./convert"

// Works through the conversion backlog in two phases:
//   1. While there's LLM quota: the most popular sites first (Tranco rank), minimal or rule-based,
//      never adult/gambling. Rule-based sites get the cheap hybrid upgrade (convert.ts).
//   2. Once the LLM quota is used up: only minimal entries ("Website at …"), with rules. Rule-based
//      entries wait for tomorrow's quota instead of being fetched for nothing.
// Every site handled gets updated_at bumped (so a run never sees it twice, and the mass crawler's
// backlog check moves on). Domains that no longer exist are flagged status=unreachable, which takes
// them out of search and out of the backlog.

const LIMIT = parseInt(process.env.RECONVERT_LIMIT || "3000")
const CONCURRENCY = parseInt(process.env.RECONVERT_CONCURRENCY || "6")
const FOREIGN_ONLY = process.env.FOREIGN_ONLY === "1"
const TIME_BUDGET_MS = parseInt(process.env.TIME_BUDGET_MIN || "150") * 60000
// After this many LLM misses in a row, stop asking the LLM for the rest of the run.
const LLM_GIVE_UP_AFTER = 6

if (!process.env.SUPABASE_SERVICE_KEY) { console.error("Missing SUPABASE_SERVICE_KEY"); process.exit(1) }

type Row = { domain: string, conversion: string | null }
const runStart = new Date().toISOString()

async function backlog(size: number, withLlm: boolean, foreign = false): Promise<Row[]> {
  const notYet = `updated_at=lt.${encodeURIComponent(runStart)}&status=is.null&owner_key=is.null`
  // First with LLM quota: sites whose only description is "X is a Danish-language website at x.dk"
  // (the rule-based converter can't write English about them): the LLM writes a real summary.
  if (withLlm && foreign) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?select=domain,conversion&${notYet}&conversion=eq.heuristic&pages->/->>content=like.*-language%20website%20at*&order=popularity_rank.asc.nullslast&limit=${size}`, { headers: SUPABASE_HEADERS })
    if (r.ok) return (await r.json()).map((row: any) => ({ domain: row.domain, conversion: row.conversion ?? null }))
    console.log(`Foreign-first query failed (${r.status}); skipping it`)
    return []
  }
  const url = withLlm
    ? `${SUPABASE_URL}/rest/v1/lawp_sites?select=domain,conversion&${notYet}&and=(or(actions.eq.%5B%5D,conversion.eq.heuristic),or(category.is.null,category.not.in.(adult,gambling)))&order=popularity_rank.asc.nullslast,updated_at.asc&limit=${size}`
    : `${SUPABASE_URL}/rest/v1/lawp_sites?select=domain,conversion&${notYet}&actions=eq.%5B%5D&order=updated_at.asc&limit=${size}`
  let r = await fetch(url, { headers: SUPABASE_HEADERS })
  // A busy database can time out on the "popular first" query: fall back to the simple one, and
  // when that times out too (another big job running), try smaller batches a little later.
  if (!r.ok && withLlm) {
    console.log(`Backlog query timed out (${r.status}); using the simple one`)
    r = await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?select=domain,conversion&${notYet}&actions=eq.%5B%5D&order=updated_at.asc&limit=${size}`, { headers: SUPABASE_HEADERS })
  }
  for (let attempt = 1; !r.ok && attempt <= 3; attempt++) {
    console.log(`Backlog query failed (${r.status}); waiting a minute, then trying a smaller batch (${attempt}/3)`)
    await new Promise(res => setTimeout(res, 60_000))
    r = await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?select=domain,conversion&${notYet}&actions=eq.%5B%5D&limit=${Math.max(20, Math.floor(size / (2 ** attempt)))}`, { headers: SUPABASE_HEADERS })
  }
  if (!r.ok) { console.log(`The database is too busy to load the backlog (${r.status}); stopping here, the next run carries on.`); return [] }
  return (await r.json()).map((row: any) => ({ domain: row.domain, conversion: row.conversion ?? null }))
}

async function touch(domain: string, extra: object = {}): Promise<void> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?domain=eq.${encodeURIComponent(domain)}`, {
    method: "PATCH",
    headers: { ...SUPABASE_HEADERS, "Content-Type": "application/json", "Prefer": "return=minimal" },
    body: JSON.stringify({ updated_at: new Date().toISOString(), ...extra })
  }).catch(e => { console.log(`touch failed ${domain}: ${e?.cause?.code || e}`); return null })
  if (r && !r.ok) console.log(`touch failed ${domain}: ${r.status} ${(await r.text()).slice(0, 120)}`)
}

async function main() {
  // Upgraded sites take more room than minimal ones: no upgrades once the free database is 80% full.
  if (await tooFullToGrow(0.8)) return
  const start = Date.now()
  const tally = { llm: 0, heuristic: 0, native: 0, unchanged: 0, skipped: 0, unreachable: 0, error: 0 }
  let processed = 0, llmMisses = 0
  const llmOn = () => llmMisses < LLM_GIVE_UP_AFTER
  // LLM calls run one at a time; llm.ts paces them to the per-minute limits.
  let llmQueue: Promise<unknown> = Promise.resolve()
  const llm = <T>(fn: () => Promise<T>): Promise<T | null> => {
    if (!llmOn()) return Promise.resolve(null)
    const run = llmQueue.then(async () => {
      if (!llmOn()) return null
      const result = await fn()
      if (result) llmMisses = 0
      else if (++llmMisses === LLM_GIVE_UP_AFTER) console.log("LLM quota looks used up — rule-based only from here, minimal entries only")
      return result
    })
    llmQueue = run.catch(() => {})
    return run
  }

  let foreignFirst = true
  while (processed < LIMIT && Date.now() - start < TIME_BUDGET_MS && !await searchNeedsTheDatabase()) {
    const withLlm = llmOn()
    let rows = withLlm && foreignFirst ? await backlog(Math.min(500, LIMIT - processed), true, true) : []
    // FOREIGN_ONLY=1 (the nightly English-summaries run): only sites that still just say "a
    // Danish-language website at …"; stop when they're done or the AI quota runs out.
    if (FOREIGN_ONLY && (!rows.length || !withLlm)) { console.log(withLlm ? "No foreign-language sites left without an English summary" : "AI quota used up for now"); break }
    if (!rows.length) { foreignFirst = false; rows = await backlog(Math.min(1000, LIMIT - processed), withLlm) }
    if (!rows.length) {
      if (withLlm) { llmMisses = LLM_GIVE_UP_AFTER; continue } // nothing left for the LLM: switch to minimal-only
      console.log("Backlog is empty"); break
    }
    console.log(`Batch: ${rows.length} sites, ${withLlm ? "popular first, with LLM" : "minimal only, rules"} (${rows.filter(r => r.conversion === "heuristic").length} rule-based to upgrade) · ${processed} done so far`)
    let index = 0

    async function worker() {
      while (index < rows.length && Date.now() - start < TIME_BUDGET_MS) {
        const row = rows[index++]
        const { domain } = row
        // Rule-based entries are only worth fetching while the LLM can upgrade them.
        if (row.conversion === "heuristic" && !llmOn()) continue
        try {
          if (INFRASTRUCTURE.test(domain + ".")) { await touch(domain); tally.skipped++; continue }
          if (await domainGone(domain)) { await touch(domain, { status: "unreachable" }); tally.unreachable++; continue }
          const native = await fetchNative(domain)
          if (native) { await saveSite(native, undefined, "native"); tally.native++; console.log(`native    ${domain}`); continue }
          if (!await robotsAllows(domain, "/")) { await touch(domain); tally.skipped++; continue }

          const page = await fetchSite(domain)
          if (page?.isHtml) await saveEvents(domain, extractEvents(page.raw, `https://${domain}/`))
          const llms = await fetchLlmsTxt(domain)
          const result = await convertSite(domain, page, llms, llmOn() ? llm : null)
          // A rule-based site the LLM couldn't upgrade stays as it is.
          // Parked or error page: flagged, which takes it out of search (cleanup_sites uses the same status).
          if (!result && page && (isParkedOrError(page.text) || notASite.has(domain))) { await touch(domain, { status: "parked" }); tally.unreachable++; continue }
          if (!result || (row.conversion === "heuristic" && result.conversion === "heuristic")) { await touch(domain); tally.unchanged++; continue }
          await saveSite(result.lawp, page ? contentHash(page.text) : undefined, result.conversion)
          tally[result.conversion]++
          console.log(`${result.conversion === "llm" ? "llm  " : "rules"}     ${domain}${result.from !== "homepage" ? ` (via ${result.from})` : ""}`)
        } catch (e: any) {
          tally.error++
          console.log(`error     ${domain}: ${e?.message || e}${e?.cause?.code ? ` (${e.cause.code})` : ""}`)
          // Always move on: an error must not keep a site at the front of the backlog.
          await touch(domain)
        }
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))
    processed += rows.length
  }
  console.log(`Done in ${Math.round((Date.now() - start) / 60000)} min. LLM ${tally.llm}, rule-based ${tally.heuristic}, native ${tally.native}, unchanged ${tally.unchanged}, skipped ${tally.skipped}, unreachable ${tally.unreachable}, errors ${tally.error}.`)
}

main()
