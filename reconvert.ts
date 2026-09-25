import { SUPABASE_URL, SUPABASE_HEADERS, fetchNative, fetchSite, toLAWP, saveSite, contentHash, robotsAllows } from "./shared"
import { heuristicLAWP, INFRASTRUCTURE } from "./heuristic"

// Works through the conversion backlog, oldest first:
//   • minimal entries ("Website at …") → LLM conversion, or the rule-based converter when no LLM
//     quota is left (no quota needed, so the backlog keeps shrinking every day)
//   • rule-based entries → upgraded to an LLM conversion whenever there's quota
// Sites that still can't be improved get updated_at bumped so the next run moves on.

const LIMIT = parseInt(process.env.RECONVERT_LIMIT || "3000")
const CONCURRENCY = parseInt(process.env.RECONVERT_CONCURRENCY || "6")
const TIME_BUDGET_MS = parseInt(process.env.TIME_BUDGET_MIN || "150") * 60000
// After this many LLM failures in a row, stop asking the LLM for the rest of the run.
const LLM_GIVE_UP_AFTER = 8

if (!process.env.SUPABASE_SERVICE_KEY) { console.error("Missing SUPABASE_SERVICE_KEY"); process.exit(1) }

type Row = { domain: string, conversion: string | null }

async function backlog(): Promise<Row[]> {
  const base = `${SUPABASE_URL}/rest/v1/lawp_sites?owner_key=is.null&order=updated_at.asc&limit=${LIMIT}`
  // With the `conversion` column (crawler_upgrade.sql): minimal and rule-based entries.
  let r = await fetch(`${base}&select=domain,conversion&or=(actions.eq.%5B%5D,conversion.eq.heuristic)`, { headers: SUPABASE_HEADERS })
  if (!r.ok) r = await fetch(`${base}&select=domain&actions=eq.%5B%5D`, { headers: SUPABASE_HEADERS })
  if (!r.ok) throw new Error(`Could not load the backlog: ${r.status} ${await r.text()}`)
  return (await r.json()).map((row: any) => ({ domain: row.domain, conversion: row.conversion ?? null }))
}

async function touch(domain: string): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?domain=eq.${encodeURIComponent(domain)}`, {
    method: "PATCH",
    headers: { ...SUPABASE_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ updated_at: new Date().toISOString() })
  })
}

async function main() {
  const start = Date.now()
  const rows = await backlog()
  console.log(`Backlog batch: ${rows.length} sites (${rows.filter(r => r.conversion === "heuristic").length} rule-based to upgrade)`)
  const tally = { llm: 0, heuristic: 0, native: 0, unchanged: 0, skipped: 0, error: 0 }
  let index = 0, llmFailures = 0
  // LLM calls run one at a time: the free per-minute limits can't take parallel requests.
  let llmQueue: Promise<unknown> = Promise.resolve()
  const llm = (domain: string, text: string) => {
    const run = llmQueue.then(() => toLAWP(domain, text))
    llmQueue = run.catch(() => {})
    return run
  }

  async function worker() {
    while (index < rows.length && Date.now() - start < TIME_BUDGET_MS) {
      const row = rows[index++]
      const { domain } = row
      try {
        if (INFRASTRUCTURE.test(domain + ".")) { await touch(domain); tally.skipped++; continue }
        const native = await fetchNative(domain)
        if (native) { await saveSite(native, undefined, "native"); tally.native++; console.log(`native    ${domain}`); continue }
        if (!await robotsAllows(domain, "/")) { await touch(domain); tally.skipped++; continue }

        const page = await fetchSite(domain)
        if (!page) { await touch(domain); tally.unchanged++; continue }

        if (llmFailures < LLM_GIVE_UP_AFTER) {
          const lawp: any = await llm(domain, page.text)
          if (Array.isArray(lawp.actions) && lawp.actions.length > 0) {
            await saveSite(lawp, contentHash(page.text), "llm")
            llmFailures = 0; tally.llm++
            console.log(`llm       ${domain}`)
            continue
          }
          if (++llmFailures === LLM_GIVE_UP_AFTER) console.log("LLM quota looks used up — continuing with rule-based conversion only")
        }

        // Rule-based only improves minimal entries; rule-based ones wait for LLM quota.
        if (row.conversion !== "heuristic") {
          const rules = heuristicLAWP(domain, page.raw, page.isHtml)
          if (rules) { await saveSite(rules, contentHash(page.text), "heuristic"); tally.heuristic++; console.log(`rules     ${domain}`); continue }
        }
        await touch(domain); tally.unchanged++
      } catch (e) {
        tally.error++
        console.log(`error     ${domain}: ${e}`)
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))
  console.log(`Done in ${Math.round((Date.now() - start) / 60000)} min. LLM ${tally.llm}, rule-based ${tally.heuristic}, native ${tally.native}, unchanged ${tally.unchanged}, skipped ${tally.skipped}, errors ${tally.error}.`)
}

main()
