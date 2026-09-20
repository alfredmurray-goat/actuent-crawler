const SUPABASE_URL = "https://bcmwypjrahtxogytsvuc.supabase.co"
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY!
const GROQ_API_KEY = process.env.GROQ_API_KEY!

import Groq from "groq-sdk"
import * as fs from "fs"
import * as path from "path"

const groq = new Groq({ apiKey: GROQ_API_KEY })

// Read domains directly from the Tranco CSV file
const csvContent = fs.readFileSync(path.join(process.cwd(), "tranco-PY96J.csv"), "utf8");
const SITES_TO_CRAWL = csvContent
  .split(/\r?\n/)
  .map(line => line.trim())
  .filter(line => line.length > 0)
  .map(line => {
    // Tranco CSVs look like "rank,domain" or just a clean list. This extracts the domain safely.
    const parts = line.split(",");
    const domain = parts[parts.length - 1]; 
    return domain.replace(/^["']|["']\$/g, "").trim(); // Remove optional quotes
  })
  .filter(domain => domain && !domain.toLowerCase().includes("domain")); // Exclude header row if present

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
    const res = await fetch("https://firecrawl.dev", {
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

    if (!res.ok) {
      console.log(`❌ ${domain} — Firecrawl error ${res.status}`)
      return null
    }

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
  const prompt = `
Convert this website content into LAWP (Locali AI Web Protocol) format.

Domain: ${domain}
Content:
${markdown.slice(0, 3000)}

Return ONLY valid JSON:
{
  "domain": "${domain}",
  "name": "Site name",
  "pages": {
    "/": { "title": "Page title", "content": "Plain English summary under 150 words" }
  },
  "actions": [
    {
      "id": "action_id",
      "name": "Action name",
      "description": "What it does",
      "intent": ["keyword1", "keyword2", "keyword3", "keyword4", "keyword5"],
      "input": { "type": "text", "required": false }
    }
  ]
}

Include 3-6 real actions the site actually supports. Be specific with intents — include product types, use cases, and synonyms.
`

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
  const exists = await alreadyCrawled(domain)
  if (exists) {
    console.log(`⏭  ${domain} — already in DB, skipping`)
    return
  }

  console.log(`🔍 Scraping ${domain} via Firecrawl...`)

  const markdown = await scrapeWithFirecrawl(domain)
  if (!markdown) {
    console.log(`❌ ${domain} — Firecrawl couldn't fetch`)
    return
  }

  const lawp = await convertToLAWP(domain, markdown)
  if (!lawp) {
    console.log(`❌ ${domain} — LAWP conversion failed`)
    return
  }

  await saveSite(lawp)
  console.log(`✅ ${domain} — saved to Supabase`)

  await new Promise(r => setTimeout(r, 1500))
}

async function main() {
  console.log(`🚀 Starting Actuent crawler — ${SITES_TO_CRAWL.length} sites\n`)
  for (const domain of SITES_TO_CRAWL) {
    await crawlSite(domain)
  }
  console.log("\n✅ Done!")
}

main()
