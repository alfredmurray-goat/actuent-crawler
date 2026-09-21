const SUPABASE_URL = "https://bcmwypjrahtxogytsvuc.supabase.co"
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY!
const GROQ_API_KEY = process.env.GROQ_API_KEY!

import Groq from "groq-sdk"
const groq = new Groq({ apiKey: GROQ_API_KEY })

const SITES_TO_CRAWL = [
  "nike.com", "adidas.com", "asics.com", "newbalance.com", "puma.com",
  "zara.com", "hm.com", "asos.com", "uniqlo.com", "gap.com",
  "apple.com", "samsung.com", "sony.com", "lg.com", "dell.com",
  "spotify.com", "netflix.com", "youtube.com", "twitch.tv", "soundcloud.com",
  "airbnb.com", "booking.com", "tripadvisor.com", "expedia.com", "hotels.com",
  "uber.com", "lyft.com", "bolt.eu", "deliveroo.com", "doordash.com",
  "amazon.com", "ebay.com", "etsy.com", "shopify.com", "aliexpress.com",
  "linkedin.com", "twitter.com", "instagram.com", "facebook.com", "reddit.com",
  "notion.so", "figma.com", "linear.app", "vercel.com", "netlify.com",
  "stripe.com", "paypal.com", "revolut.com", "monzo.com", "wise.com",
  "openai.com", "anthropic.com", "mistral.ai", "huggingface.co", "groq.com",
  "github.com", "gitlab.com", "stackoverflow.com", "npmjs.com",
  "bbc.co.uk", "theguardian.com", "nytimes.com", "techcrunch.com", "wired.com",
  "wikipedia.org", "medium.com", "substack.com", "producthunt.com", "ycombinator.com",
  "ikea.com", "target.com", "walmart.com", "bestbuy.com", "wayfair.com",
  "canva.com", "dropbox.com", "slack.com", "zoom.us", "notion.so",
  "duolingo.com", "coursera.org", "udemy.com", "khan academy.org", "skillshare.com",
  "nba.com", "bbc.co.uk/sport", "skysports.com", "espn.com", "premierleague.com",
  "ryanair.com", "easyjet.com", "britishairways.com", "klm.com", "sas.dk",
  "mcdonalds.com", "starbucks.com", "dominos.com", "papajohns.com", "subway.com",
  "tesla.com", "bmw.com", "mercedes-benz.com", "audi.com", "volkswagen.com",
  "rightmove.co.uk", "zillow.com", "realtor.com", "zoopla.co.uk", "hemnet.se",
  "healthline.com", "webmd.com", "nhs.uk", "mayoclinic.org",
  "coinbase.com", "binance.com", "kraken.com", "crypto.com",
  "wordpress.com", "wix.com", "squarespace.com", "webflow.com",
  "twilio.com", "sendgrid.com", "mailchimp.com", "hubspot.com", "salesforce.com",
  "discord.com", "telegram.org", "whatsapp.com", "signal.org",
  "tiktok.com", "pinterest.com", "snapchat.com", "tumblr.com",
  "adobe.com", "sketch.com", "invisionapp.com", "miro.com", "loom.com",
  "atlassian.com", "jira.atlassian.com", "confluence.atlassian.com",
  "digitalocean.com", "aws.amazon.com", "cloud.google.com", "azure.microsoft.com",
  "mongodb.com", "supabase.com", "planetscale.com", "neon.tech",
  "resend.com", "postmarkapp.com", "cloudflare.com", "fastly.com"
]

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
