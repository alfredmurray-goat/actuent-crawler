import Groq from "groq-sdk"
import fs from "fs"
import readline from "readline"

const SUPABASE_URL = "https://bcmwypjrahtxogytsvuc.supabase.co"
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!
const GROQ_API_KEY = process.env.GROQ_API_KEY!
const CONCURRENCY = 5
const CRAWL_LIMIT = parseInt(process.env.CRAWL_LIMIT || "500")

const SKIP = new Set(["google.com","youtube.com","facebook.com","twitter.com","instagram.com","linkedin.com","reddit.com","tiktok.com","snapchat.com","whatsapp.com","pinterest.com","t.co","bit.ly","x.com"])
const SKIP_TLDS = [".tk",".ml",".ga",".cf",".gq",".xxx"]

if (!SUPABASE_SERVICE_KEY) { console.error("Missing SUPABASE_SERVICE_KEY"); process.exit(1) }
if (!GROQ_API_KEY) { console.error("Missing GROQ_API_KEY"); process.exit(1) }

const groq = new Groq({ apiKey: GROQ_API_KEY })

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
    await fetch(`${SUPABASE_URL}/rest/v1/crawler_state?id=eq.offset`, {
      method: "PATCH",
      headers: { "apikey": SUPABASE_SERVICE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ value: v })
    })
  } catch {}
}

async function alreadyCrawled(domain: string): Promise<boolean> {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?domain=eq.${domain}&select=id`, {
      headers: { "apikey": SUPABASE_SERVICE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}` }
    })
    if (!r.ok) return false
    const data = await r.json()
    return Array.isArray(data) && data.length > 0
  } catch { return false }
}

async function scrapeJina(domain: string): Promise<string | null> {
  try {
    const r = await fetch(`https://r.jina.ai/https://${domain}`, {
      headers: { "Accept": "text/plain" },
      signal: AbortSignal.timeout(12000)
    })
    if (!r.ok) return null
    const t = await r.text()
    return t && t.length > 50 ? t.slice(0, 3000) : null
  } catch { return null }
}

async function scrapeBasic(domain: string): Promise<string | null> {
  try {
    const r = await fetch(`https://${domain}`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Actuent/1.0; +https://actuent.ai)" },
      signal: AbortSignal.timeout(8000)
    })
    if (!r.ok) return null
    const html = await r.text()
    return html.replace(/<script[\s\S]*?<\/script>/gi,"").replace(/<style[\s\S]*?<\/style>/gi,"").replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim().slice(0,3000)
  } catch { return null }
}

function minimal(domain: string, content: string = ""): any {
  const name = domain.split(".")[0]
  return {
    domain,
    name: name.charAt(0).toUpperCase() + name.slice(1),
    pages: { "/": { title: domain, content: content.slice(0, 200) || `Website at ${domain}` } },
    actions: []
  }
}

async function toLAWP(domain: string, content: string): Promise<any> {
  try {
    const c = await groq.chat.completions.create({
      model: "openai/gpt-oss-20b",
      messages: [{
        role: "user",
        content: `Convert to LAWP JSON.\n\nDomain: ${domain}\nContent: ${content}\n\nReturn ONLY valid JSON:\n{"domain":"${domain}","name":"Name","pages":{"/":{"title":"T","content":"Summary under 100 words"}},"actions":[{"id":"id","name":"N","description":"D","intent":["k1","k2","k3"],"input":{"type":"text","required":false}}]}\n\nInclude 2-4 real actions only.`
      }],
      temperature: 0.1
    })
    const raw = c.choices?.[0]?.message?.content
    if (!raw) return minimal(domain, content)
    try { return JSON.parse(raw) } catch {
      const m = raw.match(/\{[\s\S]*\}/)
      if (!m) return minimal(domain, content)
      try { return JSON.parse(m[0]) } catch { return minimal(domain, content) }
    }
  } catch { return minimal(domain, content) }
}

async function saveSite(site: any): Promise<void> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites`, {
    method: "POST",
    headers: {
      "apikey": SUPABASE_SERVICE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "resolution=merge-duplicates"
    },
    body: JSON.stringify({ domain: site.domain, name: site.name, pages: site.pages, actions: site.actions, updated_at: new Date().toISOString() })
  })
  if (!r.ok) throw new Error(await r.text())
}

async function crawlOne(domain: string, index: number, total: number): Promise<void> {
  try {
    const exists = await alreadyCrawled(domain)
    if (exists) { console.log(`[${index}/${total}] skip ${domain}`); return }

    let content = await scrapeJina(domain)
    if (!content) content = await scrapeBasic(domain)

    let lawp: any
    if (!content) {
      console.log(`[${index}/${total}] blocked — saving minimal ${domain}`)
      lawp = minimal(domain)
    } else {
      lawp = await toLAWP(domain, content)
    }

    await saveSite(lawp)
    console.log(`[${index}/${total}] SAVED ${domain}`)
    await new Promise(r => setTimeout(r, 300))
  } catch(e) {
    console.log(`[${index}/${total}] error ${domain}: ${e}`)
  }
}

async function run(domains: string[], concurrency: number): Promise<void> {
  let index = 0
  const total = domains.length
  async function worker(): Promise<void> {
    while (index < total) {
      const i = index++
      await crawlOne(domains[i], i + 1, total)
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()))
}

async function main() {
  const csvPath = "./tranco_PY69J.csv"
  if (!fs.existsSync(csvPath)) { console.error("CSV not found: " + csvPath); process.exit(1) }
  console.log("Loading CSV...")
  const all = await loadCSV(csvPath)
  console.log("Total: " + all.length)
  const offset = await getOffset()
  console.log("Offset: " + offset)
  const batch = all.slice(offset, offset + CRAWL_LIMIT)
  if (batch.length === 0) { console.log("End of CSV — resetting"); await saveOffset(0); return }
  const next = offset + CRAWL_LIMIT
  console.log(`Crawling ${batch.length} sites (pos ${offset}–${next})`)
  const start = Date.now()
  await run(batch, CONCURRENCY)
  await saveOffset(next >= all.length ? 0 : next)
  console.log(`Done in ${Math.round((Date.now()-start)/60000)} min. Next: ${next}`)
}

main()