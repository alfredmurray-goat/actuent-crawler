import zlib from "zlib"
import { robotsAllows } from "./shared"
import { USER_AGENT } from "./robots"
import { toEur, saveProducts, Item } from "./shop"
import { searchNeedsTheDatabase, tooFullToGrow } from "./quiet"

// Products from big shops that aren't on Shopify or WooCommerce (so products.ts can't read them):
// their product pages publish schema.org Product data (name, brand, price, stock, barcode). Pages come
// from the shop's product sitemap, filtered to the brands people search for most, up to PER_SHOP pages
// a run at one page a second; robots.txt is respected. Only the page's own (first) product is kept.
// Nightly: .github/workflows/schema_shops.yml. Try one shop: SHOP=zappos.com npx tsx schema_shops.ts

const PER_SHOP = parseInt(process.env.PER_SHOP || "1500")
const TIME_BUDGET_MS = parseInt(process.env.TIME_BUDGET_MIN || "90") * 60000
// The brands (and models) people ask assistants about most.
const BRANDS = /\/(nike|hoka|brooks|asics|on|on-running|saucony|new-balance|adidas|ugg|birkenstock|crocs|converse|vans|dr-martens|the-north-face|patagonia|merrell|salomon|altra|timberland|teva|keen|allbirds|reebok|puma|mizuno|clarks|sorel|columbia)-/i

type Shop = { domain: string, sitemapIndex: string, productPath: RegExp, currency: string }
const SHOPS: Shop[] = [
  { domain: "zappos.com", sitemapIndex: "https://www.zappos.com/sitemap/product_index.xml", productPath: /^https:\/\/www\.zappos\.com\/p\/[^/]+\/product\/\d+/, currency: "USD" }
]

async function getText(url: string, timeoutMs = 20000): Promise<string | null> {
  const u = new URL(url)
  if (!await robotsAllows(u.hostname, u.pathname)) return null
  const r = await fetch(url, { headers: { "User-Agent": USER_AGENT, "Accept": "text/html,application/xml" }, signal: AbortSignal.timeout(timeoutMs) }).catch(() => null)
  if (!r?.ok) return null
  const buf = Buffer.from(await r.arrayBuffer())
  // Sitemaps are often gzipped files (.xml.gz), not just gzip-encoded responses.
  if (buf[0] === 0x1f && buf[1] === 0x8b) { try { return zlib.gunzipSync(buf).toString("utf8") } catch { return null } }
  return buf.toString("utf8")
}

const locs = (xml: string) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].trim())

function firstProduct(html: string): any | null {
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let d: any
    try { d = JSON.parse(m[1].trim()) } catch { continue }
    const list = Array.isArray(d) ? d : d?.["@graph"] ? d["@graph"] : [d]
    const p = list.find((x: any) => [].concat(x?.["@type"] || []).includes("Product" as never))
    if (p) return p
  }
  return null
}

async function itemFrom(shop: Shop, url: string): Promise<Item | null> {
  const html = await getText(url)
  const p = html ? firstProduct(html) : null
  if (!p?.name) return null
  const offer = [].concat(p.offers?.offers || p.offers || [])[0] as any
  const price = Number(offer?.price ?? offer?.lowPrice)
  const brand = typeof p.brand === "string" ? p.brand : p.brand?.name
  const name = String(brand && !String(p.name).toLowerCase().startsWith(String(brand).toLowerCase()) ? `${brand} ${p.name}` : p.name).slice(0, 200)
  const gtin = [p.gtin13, p.gtin12, p.gtin14, p.gtin8, p.gtin].map(x => String(x || "").trim()).find(x => /^\d{8,14}$/.test(x)) || null
  const currency = offer?.priceCurrency || shop.currency
  return {
    domain: shop.domain, url: url.split("#")[0], name, price: Number.isFinite(price) ? price : null, currency,
    price_eur: Number.isFinite(price) ? await toEur(price, currency) : null,
    image: [].concat(p.image || [])[0] as any || null, available: offer?.availability ? /InStock|LimitedAvailability|PreOrder/i.test(String(offer.availability)) : null,
    gtin, source: "schema"
  }
}

async function main() {
  const started = Date.now()
  if (!process.env.DRY_RUN && await tooFullToGrow(0.85)) { console.log("Database nearly full: no new products this run."); return }
  for (const shop of SHOPS.filter(s => !process.env.SHOP || s.domain === process.env.SHOP)) {
    const index = await getText(shop.sitemapIndex)
    if (!index) { console.log(`${shop.domain}: no sitemap (or robots.txt says no)`); continue }
    const urls: string[] = []
    // Product sitemaps in random order, so each run covers different products.
    const maps = locs(index).sort(() => Math.random() - 0.5)
    for (const map of maps) {
      if (urls.length >= PER_SHOP * 3) break
      const xml = await getText(map, 60000)
      // Kids' products are skipped: adult searches leave them out anyway, and they'd only take space.
      if (xml) urls.push(...locs(xml).filter(u => shop.productPath.test(u) && BRANDS.test(new URL(u).pathname) && !/(kids?|toddler|infant|baby|little-kid|big-kid|youth)\b|\/brooks-brothers-/i.test(u)))
    }
    const picked = [...new Set(urls)].sort(() => Math.random() - 0.5).slice(0, PER_SHOP)
    console.log(`${shop.domain}: ${urls.length} product pages for popular brands, reading ${picked.length}`)
    const batch: Item[] = []
    let saved = 0
    for (const url of picked) {
      if (Date.now() - started > TIME_BUDGET_MS || (!process.env.DRY_RUN && await searchNeedsTheDatabase())) break
      const item = await itemFrom(shop, url).catch(() => null)
      if (process.env.DRY_RUN) { console.log(item ? `${item.name} | ${item.price} ${item.currency} | ${item.available ? "in stock" : "?"} | ${item.gtin}` : `- ${url}`); if (++saved >= 5) break; continue }
      if (item) batch.push(item)
      if (batch.length >= 100) { await saveProducts(shop.domain, batch.splice(0)); saved += 100 }
      await new Promise(r => setTimeout(r, 1000))
    }
    if (batch.length) { saved += batch.length; await saveProducts(shop.domain, batch) }
    console.log(`${shop.domain}: ${saved} products saved`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
