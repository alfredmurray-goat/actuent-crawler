// Copied from actuent-public/src/utils/products.ts (detection, currency, saving) — keep in sync.
import { USER_AGENT } from "./robots"

// Products with prices. Shops are detected automatically, with nothing for the merchant to install:
//   • Shopify stores publish /products.json and /meta.json (currency) publicly.
//   • WooCommerce stores publish the Store API at /wp-json/wc/store/v1/products.
// Prices are also stored in EUR so "under €100" works across currencies.

const SUPABASE_URL = "https://bcmwypjrahtxogytsvuc.supabase.co"
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!
const HEADERS = { "apikey": SUPABASE_SERVICE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`, "Content-Type": "application/json" }

export type Item = {
  domain: string, url: string, name: string, price: number | null, currency: string | null,
  price_eur: number | null, image: string | null, available: boolean | null, source: string
}

async function getJson(url: string, timeoutMs = 6000): Promise<any | null> {
  try {
    const r = await fetch(url, { headers: { "User-Agent": USER_AGENT, "Accept": "application/json" }, signal: AbortSignal.timeout(timeoutMs) })
    if (!r.ok || !(r.headers.get("content-type") || "").includes("json")) return null
    return await r.json()
  } catch { return null }
}

// EUR exchange rates from the ECB (via frankfurter.app), cached for 12 hours.
let rates: { values: Record<string, number>, expires: number } | null = null
async function eurRates(): Promise<Record<string, number>> {
  if (rates && rates.expires > Date.now()) return rates.values
  const data = await getJson("https://api.frankfurter.app/latest?from=EUR", 5000)
  rates = { values: { EUR: 1, ...(data?.rates || {}) }, expires: Date.now() + 12 * 3600_000 }
  return rates.values
}

export async function toEur(amount: number | null, currency: string | null): Promise<number | null> {
  if (amount == null || !currency) return null
  const rate = (await eurRates())[currency.toUpperCase()]
  return rate ? Math.round((amount / rate) * 100) / 100 : null
}

async function shopifyItems(domain: string): Promise<Item[] | null> {
  const data = await getJson(`https://${domain}/products.json?limit=250`)
  if (!Array.isArray(data?.products)) return null
  // Store currency: /meta.json (no cart created), falling back to /cart.json.
  const currency = (await getJson(`https://${domain}/meta.json`, 4000))?.currency || (await getJson(`https://${domain}/cart.json`, 4000))?.currency || null
  return data.products.map((p: any) => {
    const variant = (p.variants || [])[0] || {}
    const price = variant.price != null ? Number(variant.price) : null
    return {
      domain, url: `https://${domain}/products/${p.handle}`, name: String(p.title || "").slice(0, 200),
      price: Number.isFinite(price) ? price : null, currency, price_eur: null,
      image: p.images?.[0]?.src || null,
      available: (p.variants || []).some((v: any) => v.available !== false),
      source: "shopify"
    }
  })
}

async function wooItems(domain: string): Promise<Item[] | null> {
  const data = await getJson(`https://${domain}/wp-json/wc/store/v1/products?per_page=100`)
  if (!Array.isArray(data)) return null
  return data.map((p: any) => {
    const minor = Number(p.prices?.currency_minor_unit ?? 2)
    const raw = p.prices?.price != null ? Number(p.prices.price) / Math.pow(10, minor) : null
    return {
      domain, url: p.permalink, name: String(p.name || "").replace(/<[^>]+>/g, "").slice(0, 200),
      price: Number.isFinite(raw) ? raw : null, currency: p.prices?.currency_code || null, price_eur: null,
      image: p.images?.[0]?.src || null, available: p.is_in_stock !== false, source: "woocommerce"
    }
  }).filter((i: Item) => i.url)
}

// Detects a shop and returns its products (empty array if it isn't a supported shop).
export async function fetchProducts(domain: string): Promise<Item[]> {
  const items = (await shopifyItems(domain)) ?? (await wooItems(domain)) ?? []
  for (const item of items) item.price_eur = await toEur(item.price, item.currency)
  return items.filter(i => i.name && i.url)
}

// Saves a shop's products. Price changes keep the previous price on the item and are logged in
// lawp_item_prices, so agents can say "this dropped 20% this week".
export async function saveProducts(domain: string, items: Item[]): Promise<void> {
  const upsert = (rows: object[]) => fetch(`${SUPABASE_URL}/rest/v1/lawp_items?on_conflict=url`, {
    method: "POST", headers: { ...HEADERS, "Prefer": "resolution=merge-duplicates" }, body: JSON.stringify(rows)
  })
  try {
    if (items.length) {
      const now = new Date().toISOString()
      const before = await fetch(`${SUPABASE_URL}/rest/v1/lawp_items?select=url,price_eur&domain=eq.${encodeURIComponent(domain)}&limit=1000`, { headers: HEADERS })
        .then(r => r.ok ? r.json() : []).catch(() => [])
      const previous = new Map<string, number | null>((Array.isArray(before) ? before : []).map((r: any) => [r.url, r.price_eur == null ? null : Number(r.price_eur)]))
      const changed = items.filter(i => previous.has(i.url) && i.price_eur != null && previous.get(i.url) != null && Math.abs(previous.get(i.url)! - i.price_eur) >= 0.01)
      const changedUrls = new Set(changed.map(i => i.url))
      const rest = items.filter(i => !changedUrls.has(i.url)).map(i => ({ ...i, updated_at: now }))
      // PostgREST needs the same columns in every row of a batch, so changed items go separately.
      if (rest.length) await upsert(rest)
      if (changed.length) {
        const res = await upsert(changed.map(i => ({ ...i, updated_at: now, previous_price_eur: previous.get(i.url), price_changed_at: now })))
        if (!res.ok) await upsert(changed.map(i => ({ ...i, updated_at: now }))) // before round_three.sql
      }
      const history = [...changed, ...items.filter(i => !previous.has(i.url))]
        .filter(i => i.price != null).map(i => ({ url: i.url, price: i.price, currency: i.currency, price_eur: i.price_eur, observed_at: now }))
      if (history.length) {
        await fetch(`${SUPABASE_URL}/rest/v1/lawp_item_prices`, { method: "POST", headers: HEADERS, body: JSON.stringify(history) }).catch(() => {})
      }
    }
    await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?domain=eq.${encodeURIComponent(domain)}`, {
      method: "PATCH", headers: HEADERS, body: JSON.stringify({ products_crawled_at: new Date().toISOString() })
    })
  } catch {}
}

