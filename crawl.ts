import Groq from "groq-sdk"
import fs from "fs"
import readline from "readline"

const SUPABASE_URL = "https://bcmwypjrahtxogytsvuc.supabase.co"
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!
const GROQ_API_KEY = process.env.GROQ_API_KEY!
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY!
const CONCURRENCY = 10

const groq = new Groq({ apiKey: GROQ_API_KEY })

async function loadDomainsFromCSV(path: string): Promise<string[]> {
  const domains: string[] = []
  const rl = readline.createInterface({
    input: fs.createReadStream(path),
    crlfDelay: Infinity
  })
  for await (const line of rl) {
    const parts = line.split(",")
    const domain = parts[1]?.trim().toLowerCase()
    if (domain && domain.includes(".")) domains.push(domain)
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
      body: JSON.stringify({
        url: `https://${domain}`,
        formats: ["markdown"],
        onlyMainContent: true
      })
    })
    if (!res.ok) return null
    const data = await res.json()
    return data?.data?.markdown || null
  } catch {
    return null
  }
}

async function saveSite(site: any): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites`, {
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
}

async function convertToLAWP(domain: string, markdown: string): Promise<any | null> {
  const prompt = `Convert this website into LAWP format.

Domain: ${domain}
Content: ${markdown.slice(0, 2000)}

Return ONLY valid JSON:
{
  "domain": "${domain}",
  "name": "Site name",
  "pages": {
    "/": { "title": "Page title", "content": "Summary under 100 words" }
  },
  "actions": [
    {
      "id": "id",
      "name": "Name",
      "description": "What it does",
      "intent": ["keyword1", "keyword2", "keyword3"],
      "input": { "type": "text", "required": false }
    }
  ]
}`

  try {
    const completion = await groq.chat.completions.create({
      model: "openai/gpt-oss-20b",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1
    })
    const raw = completion.choices?.[0]?.message?.content
    if (!raw) return null
    try {
      return JSON.parse(raw)
    } catch {
      const match = raw.match(/\{[\s\S]*\}/)
      if (!match) return null
      return JSON.parse(match[0])
    }
  } catch {
    return null
  }
}

async function crawlSite(domain: string): Promise<void> {
  try {
    const exists = await alreadyCrawled(domain)
    if (exists) {
      process.stdout.write(`⏭  ${domain}\n`)
      return
    }

    const markdown = await scrapeWithFirecrawl(domain)
    if (!markdown) {
      process.stdout.write(`❌ ${domain} — blocked\n`)
      return
    }

    const lawp = await convertToLAWP(domain, markdown)
    if (!lawp) {
      process.stdout.write(`❌ ${domain} — bad LAWP\n`)
      return
    }

    await saveSite(lawp)
    process.stdout.write(`✅ ${domain}\n`)
  } catch {
    process.stdout.write(`❌ ${domain} — error\n`)
  }
}

async function runInBatches(domains: string[], concurrency: number): Promise<void> {
  let index = 0
  let done = 0
  const total = domains.length

  async function worker(): Promise<void> {
    while (index < total) {
      const domain = domains[index++]
      await crawlSite(domain)
      done++
      if (done % 100 === 0) {
        console.log(`\n📊 Progress: ${done}/${total} (${Math.round(done/total*100)}%)\n`)
      }
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker())
  await Promise.all(workers)
}

async function main() {
  const csvPath = "./tranco-PY96J.csv"

  if (!fs.existsSync(csvPath)) {
    console.error(`❌ CSV not found at ${csvPath}`)
    process.exit(1)
  }

  console.log("📖 Reading Tranco CSV...")
  const allDomains = await loadDomainsFromCSV(csvPath)
  const domains = allDomains.slice(0, 10000)

  console.log(`🚀 Crawling ${domains.length} sites with ${CONCURRENCY} concurrent workers\n`)

  await runInBatches(domains, CONCURRENCY)

  console.log("\n✅ Done!")
}

main()
