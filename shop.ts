import { fetchPublic } from "./safe-fetch"
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
  // Barcode (GTIN/EAN/UPC) when the shop publishes one: matches the same product across shops.
  gtin?: string | null
  // Shopify variant id: lets agents hand over a ready cart (https://shop/cart/<variant>:<qty>).
  variant_id?: string | null
  // Sizes and colours that are in stock, e.g. { size: ["42", "43"], colour: ["Black"] } (list_nineteen.sql).
  options?: { size?: string[], colour?: string[], size_variants?: Record<string, string> } | null
}

const SIZE_NAME = /^(size|sizes|størrelse|str|größe|grösse|taille|talla|storlek|koko|maat|taglia|shoe size|eu size)$/i
const COLOUR_NAME = /^(colou?rs?|farve|farbe|couleur|färg|väri|kleur|colore)$/i
// In-stock sizes and colours from a Shopify product's options and variants.
export function shopifyOptions(p: any): Item["options"] {
  const out: { size?: string[], colour?: string[], size_variants?: Record<string, string> } = {}
  for (const o of p.options || []) {
    const key = SIZE_NAME.test(String(o.name || "").trim()) ? "size" : COLOUR_NAME.test(String(o.name || "").trim()) ? "colour" : null
    if (!key) continue
    const field = `option${o.position || 1}`
    const available = (p.variants || []).filter((v: any) => v.available !== false)
    const inStock = new Set(available.map((v: any) => String(v[field] ?? "").trim()).filter(Boolean))
    if (inStock.size) out[key] = [...inStock].slice(0, 40) as string[]
    // Each in-stock size's variant, so a link or cart can be for exactly that size.
    if (key === "size") for (const v of available) { const s = String(v[field] ?? "").trim(); if (s && v.id != null && !(s in (out.size_variants ||= {}))) out.size_variants![s] = String(v.id) }
  }
  return out.size || out.colour ? out : null
}

async function getJson(url: string, timeoutMs = 6000): Promise<any | null> {
  try {
    const r = await fetchPublic(url, { headers: { "User-Agent": USER_AGENT, "Accept": "application/json" }, signal: AbortSignal.timeout(timeoutMs) })
    if (!r || !r.ok || !(r.headers.get("content-type") || "").includes("json")) return null
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
      gtin: /^\d{8,14}$/.test(String(variant.barcode || "").trim()) ? String(variant.barcode).trim() : null,
      variant_id: variant.id != null ? String(variant.id) : null,
      options: shopifyOptions(p),
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
      image: p.images?.[0]?.src || null, available: p.is_in_stock !== false, source: "woocommerce",
      gtin: /^\d{8,14}$/.test(String(p.sku || "").trim()) ? String(p.sku).trim() : null,
      // WooCommerce lists attribute values, not per-size stock.
      options: (() => {
        const o: { size?: string[], colour?: string[] } = {}
        for (const a of p.attributes || []) {
          const key = SIZE_NAME.test(String(a.name || "").trim()) ? "size" : COLOUR_NAME.test(String(a.name || "").trim()) ? "colour" : null
          const values = (a.terms || []).map((t: any) => String(t.name || "").trim()).filter(Boolean)
          if (key && values.length) o[key] = values.slice(0, 40)
        }
        return o.size || o.colour ? o : null
      })()
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
// Countries a shop ships to, from its shipping policy (Shopify: /policies/shipping-policy): country
// names in English and the main European languages → two-letter codes. "worldwide" → ["*"].
const COUNTRY_WORDS: [RegExp, string][] = [
  [/\b(denmark|danmark|dänemark|danemark)\b/i, "dk"], [/\b(sweden|sverige|schweden|suède)\b/i, "se"], [/\b(norway|norge|norwegen|norvège)\b/i, "no"],
  [/\b(finland|suomi|finnland)\b/i, "fi"], [/\b(germany|deutschland|tyskland|allemagne)\b/i, "de"], [/\b(netherlands|nederland|holland|niederlande)\b/i, "nl"],
  [/\b(belgium|belgië|belgique|belgien)\b/i, "be"], [/\b(france|frankrig|frankreich)\b/i, "fr"], [/\b(spain|españa|spanien|espagne)\b/i, "es"],
  [/\b(italy|italia|italien|italie)\b/i, "it"], [/\b(portugal)\b/i, "pt"], [/\b(austria|österreich|østrig)\b/i, "at"], [/\b(switzerland|schweiz|suisse)\b/i, "ch"],
  [/\b(poland|polska|polen|pologne)\b/i, "pl"], [/\b(ireland|irland|irlande)\b/i, "ie"], [/\b(united kingdom|uk|great britain|england|storbritannien|großbritannien)\b/i, "gb"],
  [/\b(united states|usa|u\.s\.|us only|contiguous us|lower 48)\b/i, "us"], [/\b(canada)\b/i, "ca"], [/\b(australia)\b/i, "au"], [/\b(new zealand)\b/i, "nz"], [/\b(japan)\b/i, "jp"]
]
export async function shippingCountries(domain: string): Promise<string[] | null> {
  try {
    const r = await fetchPublic(`https://${domain}/policies/shipping-policy`, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(6000) })
    if (!r?.ok || !/html/i.test(r.headers.get("content-type") || "")) return null
    const text = (await r.text()).replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").slice(0, 60000)
    if (/\b(worldwide|world-wide|internationally|all countries|verden over|weltweit|dans le monde entier)\b/i.test(text)) return ["*"]
    const found = COUNTRY_WORDS.filter(([re]) => re.test(text)).map(([, c]) => c)
    return found.length ? found : null
  } catch { return null }
}

export async function saveProducts(domain: string, items: Item[]): Promise<void> {
  const send = (rows: object[]) => fetch(`${SUPABASE_URL}/rest/v1/lawp_items?on_conflict=url`, {
    method: "POST", headers: { ...HEADERS, "Prefer": "resolution=merge-duplicates" }, body: JSON.stringify(rows)
  })
  // Before the gtin column exists (next_list.sql), save without it.
  const upsert = async (rows: object[]) => {
    const res = await send(rows)
    // Newest columns first (variant_id: list_seven.sql, gtin: next_list.sql).
    if (res.ok) return res
    // Before list_nineteen.sql: without the sizes and colours.
    const withoutOptions = await send(rows.map(({ options, ...rest }: any) => rest))
    if (withoutOptions.ok) return withoutOptions
    const withoutVariant = await send(rows.map(({ variant_id, options, ...rest }: any) => rest))
    return withoutVariant.ok ? withoutVariant : send(rows.map(({ variant_id, gtin, options, ...rest }: any) => rest))
  }
  // Where the shop delivers (lawp_sites.ships_to, list_twentyone.sql); only for Shopify shops, which all have the page.
  if (items[0]?.source === "shopify") {
    const ships = await shippingCountries(domain)
    if (ships) await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?domain=eq.${encodeURIComponent(domain)}`, { method: "PATCH", headers: { ...HEADERS, "Prefer": "return=minimal" }, body: JSON.stringify({ ships_to: ships }) }).catch(() => {})
  }
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

