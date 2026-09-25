import { SUPABASE_URL, SUPABASE_SERVICE_KEY, fetchNative, scrapeJina, scrapeBasic, minimal, toLAWP, saveSite, contentHash, robotsAllows } from "./shared"
import fs from "fs"
import readline from "readline"

const CONCURRENCY = parseInt(process.env.CONCURRENCY || "5")
// Max NEW sites per run. Already-indexed domains don't count towards this.
const CRAWL_LIMIT = parseInt(process.env.CRAWL_LIMIT || "35000")
// Stop starting new sites after this many minutes so the run finishes before GitHub's job timeout.
const TIME_BUDGET_MS = parseInt(process.env.TIME_BUDGET_MIN || "320") * 60000
// Domains checked against Supabase per request. The offset is checkpointed after each chunk.
const CHUNK_SIZE = 100

const SKIP = new Set(["google.com","youtube.com","facebook.com","twitter.com","instagram.com","linkedin.com","reddit.com","tiktok.com","snapchat.com","whatsapp.com","pinterest.com","t.co","bit.ly","x.com"])
const SKIP_TLDS = [".tk",".ml",".ga",".cf",".gq",".xxx"]

if (!SUPABASE_SERVICE_KEY) { console.error("Missing SUPABASE_SERVICE_KEY"); process.exit(1) }
if (!process.env.GROQ_API_KEY && !process.env.GEMINI_API_KEY && !process.env.MISTRAL_API_KEY) { console.error("Missing an LLM key (GROQ_API_KEY, GEMINI_API_KEY or MISTRAL_API_KEY)"); process.exit(1) }

async function loadCSV(path: string): Promise<string[]> {
  const domains: string[] = []
  const rl = readline.createInterface({ input: fs.createReadStream(path), crlfDelay: Infinity })
  for await (const line of rl) {
    const parts = line.split(",")
    const d = parts[1]?.trim().toLowerCase()
    if (!d || !d.includes(".") || d.startsWith("#")) continue
    if (SKIP.has(d)) continue
    if (SKIP_TLDS.some(t => d.endsWith(t))) continue
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






async function crawlOne(domain: string, label: string): Promise<boolean> {
  try {
    const native = await fetchNative(domain)
    if (!native && !await robotsAllows(domain, "/")) {
      console.log(`${label} robots.txt disallows ${domain} — skipped`)
      return false
    }
    let content = native ? null : await scrapeJina(domain)
    if (!native && !content) content = await scrapeBasic(domain)

    let lawp: any
    if (native) {
      console.log(`${label} native LAWP ${domain}`)
      lawp = native
    } else if (!content) {
      console.log(`${label} blocked — saving minimal ${domain}`)
      lawp = minimal(domain)
    } else {
      lawp = await toLAWP(domain, content)
    }

    await saveSite(lawp, content ? contentHash(content) : undefined)
    console.log(`${label} SAVED ${domain}`)
    await new Promise(r => setTimeout(r, 300))
    return true
  } catch(e) {
    console.log(`${label} error ${domain}: ${e}`)
    return false
  }
}

async function run(domains: string[], concurrency: number, labelFor: (i: number) => string): Promise<number> {
  let index = 0
  let saved = 0
  async function worker(): Promise<void> {
    while (index < domains.length) {
      const i = index++
      if (await crawlOne(domains[i], labelFor(i))) saved++
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  return saved
}

async function main() {
  const csvPath = "./tranco_PY69J.csv"
  if (!fs.existsSync(csvPath)) { console.error("CSV not found: " + csvPath); process.exit(1) }
  console.log("Loading CSV...")
  const all = await loadCSV(csvPath)
  console.log("Total: " + all.length)
  let pos = await getOffset()
  if (pos >= all.length) pos = 0
  console.log(`Offset: ${pos} — crawling up to ${CRAWL_LIMIT} new sites, ${TIME_BUDGET_MS / 60000} min budget`)

  const start = Date.now()
  let attempted = 0, saved = 0, skipped = 0

  while (pos < all.length && attempted < CRAWL_LIMIT && Date.now() - start < TIME_BUDGET_MS) {
    const chunk = all.slice(pos, pos + CHUNK_SIZE)
    const todo = await filterUncrawled(chunk)
    skipped += chunk.length - todo.length
    const base = attempted
    saved += await run(todo, CONCURRENCY, i => `[${base + i + 1}]`)
    attempted += todo.length
    pos += chunk.length
    // Checkpoint after every chunk so a cancelled or timed-out run keeps its progress.
    await saveOffset(pos >= all.length ? 0 : pos)
    console.log(`— pos ${pos}/${all.length} · saved ${saved} · already indexed ${skipped} · ${Math.round((Date.now() - start) / 60000)} min`)
  }

  if (pos >= all.length) console.log("End of CSV — offset reset to 0")
  console.log(`Done in ${Math.round((Date.now() - start) / 60000)} min. Saved ${saved}, skipped ${skipped} already indexed. Next offset: ${pos >= all.length ? 0 : pos}`)
}

main()