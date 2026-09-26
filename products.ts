import fs from "fs"
import readline from "readline"
import { SUPABASE_URL, SUPABASE_HEADERS, robotsAllows } from "./shared"
import { fetchProducts, saveProducts } from "./shop"
import { checkWatches } from "./watches"

// Indexes products with prices from shops among the top indexed sites (Tranco order): Shopify
// (/products.json) and WooCommerce (Store API). No LLM. Shops are refreshed every 14 days.

const TOP = parseInt(process.env.PRODUCTS_TOP || "50000")
const TIME_BUDGET_MS = parseInt(process.env.TIME_BUDGET_MIN || "150") * 60000
const CONCURRENCY = 6
const CHUNK = 100

if (!process.env.SUPABASE_SERVICE_KEY) { console.error("Missing SUPABASE_SERVICE_KEY"); process.exit(1) }

async function topDomains(path: string): Promise<string[]> {
  const out: string[] = []
  const rl = readline.createInterface({ input: fs.createReadStream(path), crlfDelay: Infinity })
  for await (const line of rl) {
    const d = line.split(",")[1]?.trim().toLowerCase()
    if (d && d.includes(".")) out.push(d)
    if (out.length >= TOP) break
  }
  return out
}

async function due(domains: string[]): Promise<string[]> {
  const list = encodeURIComponent(domains.map(d => `"${d}"`).join(","))
  const cutoff = encodeURIComponent(new Date(Date.now() - 14 * 86400000).toISOString())
  const r = await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?select=domain&domain=in.(${list})&or=(products_crawled_at.is.null,products_crawled_at.lt.${cutoff})`, { headers: SUPABASE_HEADERS })
  if (!r.ok) throw new Error(`Could not load sites: ${r.status} ${await r.text()}`)
  return (await r.json()).map((row: any) => row.domain)
}

// Shops with watched products (price-drop alerts) are refreshed every day, before anything else.
async function watchedDomains(): Promise<string[]> {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/price_watches?select=domain&limit=5000`, { headers: SUPABASE_HEADERS })
    return r.ok ? [...new Set<string>((await r.json()).map((w: any) => w.domain))] : []
  } catch { return [] }
}

async function main() {
  const start = Date.now()
  const domains = await topDomains("./tranco_PY69J.csv")
  let checked = 0, shops = 0, items = 0, alerts = 0

  const watched = await watchedDomains()
  if (watched.length) console.log(`Refreshing ${watched.length} shops with price watches`)
  for (const domain of watched) {
    try {
      const found = await fetchProducts(domain)
      if (found.length) { await saveProducts(domain, found); alerts += await checkWatches(domain, found) }
    } catch (e) { console.log(`error ${domain}: ${e}`) }
  }
  if (watched.length) console.log(`${alerts} alerts sent`)

  console.log(`Checking the top ${domains.length} sites for shops`)
  for (let i = 0; i < domains.length && Date.now() - start < TIME_BUDGET_MS; i += CHUNK) {
    const todo = await due(domains.slice(i, i + CHUNK))
    let index = 0
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (index < todo.length) {
        const domain = todo[index++]
        try {
          const found = await robotsAllows(domain, "/products.json") ? await fetchProducts(domain) : []
          await saveProducts(domain, found)
          checked++
          if (found.length) { shops++; items += found.length; console.log(`+${found.length} products ${domain}`) }
        } catch (e) { console.log(`error ${domain}: ${e}`) }
      }
    }))
  }
  console.log(`Done in ${Math.round((Date.now() - start) / 60000)} min. ${checked} sites checked, ${shops} shops, ${items} products indexed.`)
}

main()
