import { SUPABASE_URL, SUPABASE_SERVICE_KEY, fetchNative, fetchSite, minimal, toLAWP, saveSite, contentHash, robotsAllows } from "./shared"
import { heuristicLAWP, INFRASTRUCTURE } from "./heuristic"
import { extractBusiness } from "./business"
import fs from "fs"
import readline from "readline"

const CONCURRENCY = parseInt(process.env.CONCURRENCY || "5")
// Max NEW sites per run. Already-indexed domains don't count towards this.
// Target number of sites saved WITH real content. Blocked, robots-disallowed, errored and
// minimal-only sites don't count, so each one adds one more site to the run.
const CRAWL_LIMIT = parseInt(process.env.CRAWL_LIMIT || "20000")
// Stop starting new sites after this many minutes so the run finishes before GitHub's job timeout.
const TIME_BUDGET_MS = parseInt(process.env.TIME_BUDGET_MIN || "320") * 60000
// Domains checked against Supabase per request. The offset is checkpointed after each chunk.
const CHUNK_SIZE = 100

const SKIP = new Set(["google.com","youtube.com","facebook.com","twitter.com","instagram.com","linkedin.com","reddit.com","tiktok.com","snapchat.com","whatsapp.com","pinterest.com","t.co","bit.ly","x.com"])
const SKIP_TLDS = [".tk",".ml",".ga",".cf",".gq",".xxx"]

if (!SUPABASE_SERVICE_KEY) { console.error("Missing SUPABASE_SERVICE_KEY"); process.exit(1) }
if (!process.env.GROQ_API_KEY) console.log("No GROQ_API_KEY — using other LLM providers or the rule-based converter")

async function loadCSV(path: string): Promise<string[]> {
  const domains: string[] = []
  const rl = readline.createInterface({ input: fs.createReadStream(path), crlfDelay: Infinity })
  for await (const line of rl) {
    const parts = line.split(",")
    const d = parts[1]?.trim().toLowerCase()
    if (!d || !d.includes(".") || d.startsWith("#")) continue
    if (SKIP.has(d)) continue
    if (SKIP_TLDS.some(t => d.endsWith(t))) continue
    if (INFRASTRUCTURE.test(d + ".")) continue // DNS/CDN/ad hosts, not websites
    domains.push(d)
  }
  return domains
}

async function getOffset(): Promise<number> {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/crawler_state?id=eq.offset&select=value`, {
      headers: { "apikey": SUPABASE_SERVICE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}` }
    })
    const data = await r.json()
    return data?.[0]?.value || 0
  } catch { return 0 }
}

async function saveOffset(v: number): Promise<void> {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/crawler_state?id=eq.offset`, {
      method: "PATCH",
      headers: { "apikey": SUPABASE_SERVICE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ value: v })
    })
    if (!r.ok) console.log(`offset save failed: ${r.status} ${await r.text()}`)
  } catch (e) { console.log(`offset save failed: ${e}`) }
}

async function filterUncrawled(domains: string[]): Promise<string[]> {
  const list = domains.map(d => `"${d}"`).join(",")
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?select=domain&domain=in.(${encodeURIComponent(list)})`, {
        headers: { "apikey": SUPABASE_SERVICE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}` }
      })
      if (!r.ok) throw new Error(`${r.status} ${await r.text()}`)
      const rows: { domain: string }[] = await r.json()
      const existing = new Set(rows.map(row => row.domain))
      return domains.filter(d => !existing.has(d))
    } catch (e) {
      console.log(`existence check failed (attempt ${attempt + 1}): ${e}`)
      await new Promise(r => setTimeout(r, 2000))
    }
  }
  // Saving is an upsert, so re-crawling a known site is safe, just slower.
  return domains
}






type Outcome = "full" | "minimal" | "skipped" | "error"

async function crawlOne(domain: string, label: string): Promise<Outcome> {
  try {
    const native = await fetchNative(domain)
    if (!native && !await robotsAllows(domain, "/")) {
      console.log(`${label} robots.txt disallows ${domain} — skipped`)
      return "skipped"
    }
    const page = native ? null : await fetchSite(domain)

    let lawp: any
    let conversion: "native" | "llm" | "heuristic" | "minimal"
    if (native) {
      console.log(`${label} native LAWP ${domain}`)
      lawp = native; conversion = "native"
    } else if (!page) {
      console.log(`${label} blocked — saving minimal ${domain}`)
      lawp = minimal(domain); conversion = "minimal"
    } else {
      lawp = await toLAWP(domain, page.text)
      conversion = "llm"
      // No LLM available (or unusable output): build it from the page itself instead.
      if (!Array.isArray(lawp.actions) || lawp.actions.length === 0) {
        const rules = heuristicLAWP(domain, page.raw, page.isHtml)
        if (rules) { lawp = rules; conversion = "heuristic" } else { conversion = "minimal" }
      }
    }

    // Address, phone and opening hours from the site's schema.org data.
    if (page?.isHtml && !lawp.business) { const business = extractBusiness(page.raw); if (business) lawp.business = business }
    await saveSite(lawp, page ? contentHash(page.text) : undefined, conversion)
    const full = conversion !== "minimal"
    console.log(`${label} SAVED (${conversion}) ${domain}`)
    await new Promise(r => setTimeout(r, 300))
    return full ? "full" : "minimal"
  } catch(e) {
    console.log(`${label} error ${domain}: ${e}`)
    return "error"
  }
}

async function run(domains: string[], concurrency: number, labelFor: (i: number) => string): Promise<Record<Outcome, number>> {
  let index = 0
  const tally: Record<Outcome, number> = { full: 0, minimal: 0, skipped: 0, error: 0 }
  async function worker(): Promise<void> {
    while (index < domains.length) {
      const i = index++
      tally[await crawlOne(domains[i], labelFor(i))]++
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  return tally
}

// New sites are paused until the backlog has been retried once with the upgraded converter:
// no minimal entry left that hasn't been touched since RECRAWL_CUTOFF. Resumes automatically.
const RECRAWL_CUTOFF = process.env.RECRAWL_CUTOFF || "2026-09-26T12:00:00Z"

async function backlogRemaining(): Promise<number | null> {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?select=domain&actions=eq.%5B%5D&owner_key=is.null&updated_at=lt.${encodeURIComponent(RECRAWL_CUTOFF)}`, {
      method: "HEAD",
      headers: { "apikey": SUPABASE_SERVICE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`, "Prefer": "count=exact", "Range": "0-0" }
    })
    const total = r.headers.get("content-range")?.split("/")[1]
    return total && total !== "*" ? Number(total) : null
  } catch { return null }
}

async function main() {
  if (process.env.IGNORE_BACKLOG !== "true") {
    const remaining = await backlogRemaining()
    if (remaining && remaining > 0) {
      console.log(`Paused: ${remaining.toLocaleString()} backlog sites still to retry with the upgraded converter. New sites resume automatically once they're done (or run with IGNORE_BACKLOG=true).`)
      return
    }
  }

  const csvPath = "./tranco_PY69J.csv"
  if (!fs.existsSync(csvPath)) { console.error("CSV not found: " + csvPath); process.exit(1) }
  console.log("Loading CSV...")
  const all = await loadCSV(csvPath)
  console.log("Total: " + all.length)
  let pos = await getOffset()
  if (pos >= all.length) pos = 0
  console.log(`Offset: ${pos} — crawling up to ${CRAWL_LIMIT} new sites, ${TIME_BUDGET_MS / 60000} min budget`)

  const start = Date.now()
  let attempted = 0, alreadyIndexed = 0
  const totals: Record<Outcome, number> = { full: 0, minimal: 0, skipped: 0, error: 0 }

  // Keep going until CRAWL_LIMIT sites are saved with real content (or time runs out).
  while (pos < all.length && totals.full < CRAWL_LIMIT && Date.now() - start < TIME_BUDGET_MS) {
    const chunk = all.slice(pos, pos + CHUNK_SIZE)
    const todo = await filterUncrawled(chunk)
    alreadyIndexed += chunk.length - todo.length
    const base = attempted
    const tally = await run(todo, CONCURRENCY, i => `[${base + i + 1}]`)
    for (const k of Object.keys(tally) as Outcome[]) totals[k] += tally[k]
    attempted += todo.length
    pos += chunk.length
    // Checkpoint after every chunk so a cancelled or timed-out run keeps its progress.
    await saveOffset(pos >= all.length ? 0 : pos)
    console.log(`— pos ${pos}/${all.length} · full ${totals.full}/${CRAWL_LIMIT} · minimal ${totals.minimal} · skipped ${totals.skipped} · errors ${totals.error} · already indexed ${alreadyIndexed} · ${Math.round((Date.now() - start) / 60000)} min`)
  }

  if (pos >= all.length) console.log("End of CSV — offset reset to 0")
  console.log(`Done in ${Math.round((Date.now() - start) / 60000)} min. Full ${totals.full}, minimal ${totals.minimal}, skipped ${totals.skipped}, errors ${totals.error}, already indexed ${alreadyIndexed}. Next offset: ${pos >= all.length ? 0 : pos}`)
}

main()