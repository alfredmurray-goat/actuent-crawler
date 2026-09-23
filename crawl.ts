import Groq from "groq-sdk"
import fs from "fs"
import readline from "readline"

const SUPABASE_URL = "https://bcmwypjrahtxogytsvuc.supabase.co"
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!
const GROQ_API_KEY = process.env.GROQ_API_KEY!
const CONCURRENCY = 5
const CRAWL_LIMIT = parseInt(process.env.CRAWL_LIMIT || "500")

const SKIP_DOMAINS = new Set([
  "google.com","youtube.com","facebook.com","twitter.com","instagram.com",
  "linkedin.com","reddit.com","tiktok.com","snapchat.com","whatsapp.com",
  "pinterest.com","tumblr.com","t.co","bit.ly","goo.gl","x.com"
])
const SKIP_TLDS = [".tk",".ml",".ga",".cf",".gq",".xxx",".adult"]

if (!SUPABASE_SERVICE_KEY) { console.error("Missing SUPABASE_SERVICE_KEY"); process.exit(1) }
if (!GROQ_API_KEY) { console.error("Missing GROQ_API_KEY"); process.exit(1) }

const groq = new Groq({ apiKey: GROQ_API_KEY })

async function getOffset(): Promise<number> {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/crawler_state?id=eq.offset&select=value`,
      { headers: { "apikey": SUPABASE_SERVICE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}` } }
    )
    const data = await res.json()
    return data?.[0]?.value || 0
  } catch { return 0 }
}

async function saveOffset(offset: number): Promise<void> {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/crawler_state?id=eq.offset`, {
      method: "PATCH",
      headers: {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ value: offset })
    })
  } catch {}
}

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
  } catch { return false }
}

async function scrapeWithJina(domain: string): Promise<string | null> {
  try {
    const res = await fetch(`https://r.jina.ai/https://${domain}`, {
      headers: { "Accept": "text/plain", "X-No-Cache": "true" },
      signal: AbortSignal.timeout(15000)
    })
    if (!res.ok) return null
    const text = await res.text()
    if (!text || text.length < 100) return null
    return text.slice(0, 3000)
  } catch { return null }
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
    body: JSON.stringify({ domain: site.domain, name: site.name, pages: site.pages, actions: site.actions, updated_at: new Date().toISOString() })
  })
  if (!res.ok) throw new Error(`Save failed: ${await res.text()}`)
}

async function convertToLAWP(domain: string, content: string): Promise<any | null> {
  try {
    const completion = await groq.chat.completions.create({
      model: "openai/gpt-oss-20b",
      messages: [{
        role: "user",
        content: `Convert this website content into LAWP format.\n\nDomain: ${domain}\nContent: ${content}\n\nReturn ONLY valid JSON:\n{"domain":"${domain}","name":"Site name","pages":{"/":{"title":"Title","content":"Summary under 100 words"}},"actions":[{"id":"id","name":"Name","description":"What","intent":["k1","k2","k3"],"input":{"type":"text","required":false}}]}\n\nInclude 2-4 real actions only.`
      }],
      temperature: 0.1
    })
    const raw = completion.choices?.[0]?.message?.content
    if (!raw) return null
    try { return JSON.parse(raw) } catch {
      const match = raw.match(/\{[\s\S]*\}/)
      return match ? JSON.parse(match[0]) : null
    }
  } catch { return null }
}

async function crawlSite(domain: string, index: number, total: number): Promise<void> {
  try {
    const exists = await alreadyCrawled(domain)
    if (exists) { console.log(`[${index}/${total}] skip ${domain}`); return }
    const content = await scrapeWithJina(domain)
    if (!content) { console.log(`[${index}/${total}] blocked ${domain}`); return }
    const lawp = await convertToLAWP(domain, content)
       if (!lawp) {
      lawp = {
        domain,
        name: domain.split(".")[0].charAt(0).toUpperCase() + domain.split(".")[0].slice(1),
        pages: { "/": { title: domain, content: content.slice(0, 200) } },
        actions: []
      }
    }
    await saveSite(lawp)
    console.log(`[${index}/${total}] SAVED ${domain}`)
    await new Promise(r => setTimeout(r, 500))
  } catch(e) {
    console.log(`[${index}/${total}] error ${domain}: ${e}`)
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
  if (!fs.existsSync(csvPath)) { console.error(`CSV not found: ${csvPath}`); process.exit(1) }

  console.log("Loading CSV...")
  const allDomains = await loadDomainsFromCSV(csvPath)
  console.log(`Total domains in CSV: ${allDomains.length}`)

  const currentOffset = await getOffset()
  console.log(`Current offset: ${currentOffset}`)

  const domains = allDomains.slice(currentOffset, currentOffset + CRAWL_LIMIT)

  if (domains.length === 0) {
    console.log("Reached end of CSV — resetting offset to 0")
    await saveOffset(0)
    return
  }

  const nextOffset = currentOffset + CRAWL_LIMIT
  console.log(`Crawling positions ${currentOffset}–${nextOffset} with ${CONCURRENCY} workers`)

  const start = Date.now()
  await runInBatches(domains, CONCURRENCY)

  await saveOffset(nextOffset >= allDomains.length ? 0 : nextOffset)
  console.log(`Done in ${Math.round((Date.now() - start) / 60000)} minutes. Next offset: ${nextOffset}`)
}

main()