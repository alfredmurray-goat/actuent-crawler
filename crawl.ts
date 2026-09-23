import Groq from "groq-sdk"
import fs from "fs"
import readline from "readline"

const SUPABASE_URL = "https://bcmwypjrahtxogytsvuc.supabase.co"
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!
const GROQ_API_KEY = process.env.GROQ_API_KEY!
const CONCURRENCY = 5
const CRAWL_LIMIT = parseInt(process.env.CRAWL_LIMIT || "500")

const SKIP_DOMAINS = new Set([
  "google.com", "youtube.com", "facebook.com", "twitter.com", "instagram.com",
  "linkedin.com", "reddit.com", "tiktok.com", "snapchat.com", "whatsapp.com",
  "pinterest.com", "tumblr.com", "t.co", "bit.ly", "goo.gl"
])

const SKIP_TLDS = [".tk", ".ml", ".ga", ".cf", ".gq", ".xxx", ".adult"]

if (!SUPABASE_SERVICE_KEY) { console.error("Missing SUPABASE_SERVICE_KEY"); process.exit(1) }
if (!GROQ_API_KEY) { console.error("Missing GROQ_API_KEY"); process.exit(1) }

const groq = new Groq({ apiKey: GROQ_API_KEY })

async function loadDomainsFromCSV(path: string): Promise<string[]> {
  const domains: string[] = []
  const rl = readline.createInterface({ input: fs.createReadStream(path), crlfDelay: Infinity })
  for await (const line of rl) {
    const parts = line.split(",")
    const domain = parts[1]?.trim().toLowerCase()
    if (!domain || !domain.includes(".") || domain.startsWith("#")) continue
    if (SKIP_DOMAINS.has(domain)) continue
    if (SKIP_TLDS.some(tld => domain.endsWith(tld))) continue
    domains.push(domain)
  }
  return domains
}

async function alreadyCrawled(domain: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/lawp_sites?domain=eq.${domain}&select=id`,
      { headers: { "apikey": SUPABASE_SERVICE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}` } }
    )
    if (!res.ok) return false
    const data = await res.json()
    return Array.isArray(data) && data.length > 0
  } catch {
    return false
  }
}

async function scrapeWithJina(domain: string): Promise<string | null> {
  try {
    const res = await fetch(`https://r.jina.ai/https://${domain}`, {
      headers: {
        "Accept": "text/plain",
        "X-No-Cache": "true"
      },
      signal: AbortSignal.timeout(15000)
    })
    if (!res.ok) return null
    const text = await res.text()
    if (!text || text.length < 100) return null
    return text.slice(0, 3000)
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
  if (!res.ok) throw new Error(`Save failed: ${await res.text()}`)
}

async function convertToLAWP(domain: string, content: string): Promise<any | null> {
  try {
    const completion = await groq.chat.completions.create({
      model: "openai/gpt-oss-20b",
      messages: [{
        role: "user",
        content: `Convert this website content into LAWP format.\n\nDomain: ${domain}\nContent: ${content}\n\nReturn ONLY valid JSON:\n{"domain":"${domain}","name":"Site name","pages":{"/":{"title":"Title","content":"Plain English summary under 100 words"}},"actions":[{"id":"id","name":"Name","description":"What it does","intent":["k1","k2","k3"],"input":{"type":"text","required":false}}]}\n\nInclude 2-4 real actions only.`
      }],
      temperature: 0.1
    })
    const raw = completion.choices?.[0]?.message?.content
    if (!raw) return null
    try { return JSON.parse(raw) } catch {
      const match = raw.match(/\{[\s\S]*\}/)
      return match ? JSON.parse(match[0]) : null
    }
  } catch {
    return null
  }
}

async function crawlSite(domain: string, index: number, total: number): Promise<void> {
  try {
    const exists = await alreadyCrawled(domain)
    if (exists) { console.log(`[${index}/${total}] skip ${domain}`); return }

    const content = await scrapeWithJina(domain)
    if (!content) { console.log(`[${index}/${total}] blocked ${domain}`); return }

    const lawp = await convertToLAWP(domain, content)
    if (!lawp) { console.log(`[${index}/${total}] bad lawp ${domain}`); return }

    await saveSite(lawp)
    console.log(`[${index}/${total}] saved ${domain}`)

    await new Promise(r => setTimeout(r, 500))
  } catch(e) {
    console.log(`[${index}/${total}] error ${domain}: ${e}`)
  }
}

async function runInBatches(domains: string[], concurrency: number): Promise<void> {
  let index = 0
  const total = domains.length
  let saved = 0

  async function worker(): Promise<void> {
    while (index < total) {
      const i = index++
      const before = saved
      await crawlSite(domains[i], i + 1, total)
      if (saved > before) saved++
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))
}

async function main() {
  const csvPath = "./tranco_PY69J.csv"
  if (!fs.existsSync(csvPath)) { console.error(`CSV not found: ${csvPath}`); process.exit(1) }
  console.log("Loading CSV...")
  const allDomains = await loadDomainsFromCSV(csvPath)
  const domains = allDomains.slice(0, CRAWL_LIMIT)
  console.log(`Crawling ${domains.length} sites with ${CONCURRENCY} workers using Jina Reader`)
  const start = Date.now()
  await runInBatches(domains, CONCURRENCY)
  console.log(`Done in ${Math.round((Date.now() - start) / 60000)} minutes`)
}

main()