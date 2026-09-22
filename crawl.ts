import Groq from "groq-sdk"
import fs from "fs"
import readline from "readline"

const SUPABASE_URL = "https://bcmwypjrahtxogytsvuc.supabase.co"
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!
const GROQ_API_KEY = process.env.GROQ_API_KEY!
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY!
const CONCURRENCY = 10
const CRAWL_LIMIT = parseInt(process.env.CRAWL_LIMIT || "500")

if (!SUPABASE_SERVICE_KEY) { console.error("❌ Missing SUPABASE_SERVICE_KEY"); process.exit(1) }
if (!GROQ_API_KEY) { console.error("❌ Missing GROQ_API_KEY"); process.exit(1) }
if (!FIRECRAWL_API_KEY) { console.error("❌ Missing FIRECRAWL_API_KEY"); process.exit(1) }

const groq = new Groq({ apiKey: GROQ_API_KEY })

async function loadDomainsFromCSV(path: string): Promise<string[]> {
  const domains: string[] = []
  const rl = readline.createInterface({ input: fs.createReadStream(path), crlfDelay: Infinity })
  for await (const line of rl) {
    const parts = line.split(",")
    const domain = parts[1]?.trim().toLowerCase()
    if (domain && domain.includes(".") && !domain.startsWith("#")) domains.push(domain)
  }
  return domains
}

async function alreadyCrawled(domain: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/lawp_sites?domain=eq.${domain}&select=id`,
      {
        headers: {
          "apikey": SUPABASE_SERVICE_KEY,
          "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`
        }
      }
    )
    if (!res.ok) return false
    const data = await res.json()
    return Array.isArray(data) && data.length > 0
  } catch {
    return false
  }
}

async function scrapeWithFirecrawl(domain: string): Promise<string | null> {
  try {
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${FIRECRAWL_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ url: `https://${domain}`, formats: ["markdown"], onlyMainContent: true })
    })
    if (!res.ok) return null
    const data = await res.json()
    return data?.data?.markdown || null
  } catch {
    return null
  }
}

async function saveSite(site: any): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites`, {
    method: "POST",
    headers: {
      "apikey": SUPABASE_SERVICE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "resolution=merge-duplicates"
    },
    body: JSON.stringify({
      domain: site.domain,
      name: site.name,
      pages: site.pages,
      actions: site.actions,
      updated_at: new Date().toISOString()
    })
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Supabase save failed: ${err}`)
  }
}

async function convertToLAWP(domain: string, markdown: string): Promise<any | null> {
  try {
    const completion = await groq.chat.completions.create({
      model: "openai/gpt-oss-20b",
      messages: [{
        role: "user",
        content: `Convert this website into LAWP format.

Domain: ${domain}
Content: ${markdown.slice(0, 2000)}

Return ONLY valid JSON:
{
  "domain": "${domain}",
  "name": "Site name",
  "pages": { "/": { "title": "Title", "content": "Summary under 100 words" } },
  "actions": [{ "id": "id", "name": "Name", "description": "What", "intent": ["k1","k2","k3"], "input": { "type": "text", "required": false } }]
}`
      }],
      temperature: 0.1
    })
    const raw = completion.choices?.[0]?.message?.content
    if (!raw) return null
    try { return JSON.parse(raw) } catch {
      const match = raw.match(/\{[\s\S]*\}/)
      if (!match) return null
      return JSON.parse(match[0])
    }
  } catch {
    return null
  }
}

async function crawlSite(domain: string, index: number, total: number): Promise<void> {
  try {
    const exists = await alreadyCrawled(domain)
    if (exists) {
      console.log(`[${index}/${total}] ⏭  ${domain}`)
      return
    }
    const markdown = await scrapeWithFirecrawl(domain)
    if (!markdown) {
      console.log(`[${index}/${total}] ❌ ${domain} — blocked`)
      return
    }
    const lawp = await convertToLAWP(domain, markdown)
    if (!lawp) {
      console.log(`[${index}/${total}] ❌ ${domain} — bad LAWP`)
      return
    }
    await saveSite(lawp)
    console.log(`[${index}/${total}] ✅ ${domain}`)
  } catch(e) {
    console.log(`[${index}/${total}] ❌ ${domain} — ${e}`)
  }
}

async function runInBatches(domains: string[], concurrency: number): Promise<void> {
  let index = 0
  const total = domains.length

  async function worker(): Promise<void> {
    while (index < total) {
      const i = index++
      await crawlSite(domains[i], i + 1, total)
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))
}

async function main() {
  const csvPath = "./tranco_PY69J.csv"
  if (!fs.existsSync(csvPath)) { console.error(`❌ CSV not found at ${csvPath}`); process.exit(1) }

  console.log("📖 Loading Tranco CSV...")
  const allDomains = await loadDomainsFromCSV(csvPath)
  const domains = allDomains.slice(0, CRAWL_LIMIT)

  console.log(`🚀 Crawling ${domains.length} sites with ${CONCURRENCY} concurrent workers\n`)
  const start = Date.now()

  await runInBatches(domains, CONCURRENCY)

  const mins = Math.round((Date.now() - start) / 60000)
  console.log(`\n✅ Done in ${mins} minutes`)
}

main()
