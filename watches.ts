import { SUPABASE_URL, SUPABASE_HEADERS } from "./shared"
import { sendEmail, esc } from "./email"

// Price-drop and back-in-stock alerts (Pro): after a shop's products are saved, anyone watching one
// of them gets an email and/or a webhook when its price drops (to their target, if set) or when a
// sold-out product is available again. Needs price_watches (next_list.sql + list_four.sql).

type Watch = { id: number, api_key: string, url: string, name: string | null, target_price_eur: number | null, last_price_eur: number | null, webhook_url: string | null,
  notify_price?: boolean, notify_stock?: boolean, last_available?: boolean | null }
type Priced = { url: string, name: string, price: number | null, currency: string | null, price_eur: number | null, available?: boolean | null }

async function notify(w: Watch, domain: string, payload: object, subject: string, html: string) {
  if (w.webhook_url?.startsWith("https://")) {
    await fetch(w.webhook_url, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "Actuent/1.0 (+https://actuent.ai)" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(8000) }).catch(() => {})
  }
  const email = await accountEmail(w.api_key)
  if (email) await sendEmail(email, subject, html + `<p style="color:#666;font-size:13px">You're getting this because you asked your AI assistant to watch this product with Actuent. Ask it to stop watching to turn this off.</p>`)
}

async function accountEmail(keyHash: string): Promise<string | null> {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/api_keys?select=email&key_hash=eq.${keyHash}`, { headers: SUPABASE_HEADERS })
    const [row] = r.ok ? await r.json() : []
    return row?.email || null
  } catch { return null }
}

export async function checkWatches(domain: string, items: Priced[]): Promise<number> {
  let watches: Watch[] = []
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/price_watches?select=*&domain=eq.${encodeURIComponent(domain)}`, { headers: SUPABASE_HEADERS })
    if (!r.ok) return 0
    watches = await r.json()
  } catch { return 0 }
  const byUrl = new Map(items.map(i => [i.url, i]))
  let sent = 0
  for (const w of watches) {
    const item = byUrl.get(w.url)
    if (!item) continue
    const name = item.name || w.name || "A product you're watching"
    const patch: Record<string, unknown> = {}

    // Back in stock: it was sold out last time and is available now.
    const available = item.available !== false
    if (w.notify_stock && w.last_available === false && available) {
      await notify(w, domain, { event: "back_in_stock", url: w.url, name, domain, price: item.price, currency: item.currency, price_eur: item.price_eur },
        `Back in stock: ${name}`,
        `<p><strong>${esc(name)}</strong> is available again on ${esc(domain)}${item.price != null ? `, at ${esc(item.price)} ${esc(item.currency || "")}` : ""}.</p><p><a href="${esc(w.url)}">View it on ${esc(domain)} →</a></p>`)
      patch.notified_at = new Date().toISOString(); sent++
    }
    if (w.notify_stock !== undefined) patch.last_available = available

    // Price drop (to the target, if one was set).
    if (item.price_eur != null) {
      const now = Number(item.price_eur), before = w.last_price_eur == null ? null : Number(w.last_price_eur)
      const dropped = before != null && now < before - 0.01
      const hitTarget = w.target_price_eur == null || now <= Number(w.target_price_eur)
      if (w.notify_price !== false && dropped && hitTarget && available) {
        const percent = Math.round(((before! - now) / before!) * 100)
        await notify(w, domain, { event: "price_drop", url: w.url, name, domain, price: item.price, currency: item.currency, price_eur: now, previous_price_eur: before, percent_off: percent, target_price_eur: w.target_price_eur },
          `Price drop: ${name} is now ${item.price} ${item.currency || ""} (−${percent}%)`,
          `<p><strong>${esc(name)}</strong> on ${esc(domain)} dropped from €${esc(before!.toFixed(2))} to <strong>€${esc(now.toFixed(2))}</strong> (${esc(item.price)} ${esc(item.currency || "")}), ${percent}% off.</p><p><a href="${esc(w.url)}">View it on ${esc(domain)} →</a></p>`)
        patch.notified_at = new Date().toISOString(); sent++
      }
      patch.last_price_eur = now
    }
    if (Object.keys(patch).length) {
      await fetch(`${SUPABASE_URL}/rest/v1/price_watches?id=eq.${w.id}`, {
        method: "PATCH", headers: { ...SUPABASE_HEADERS, "Content-Type": "application/json" }, body: JSON.stringify(patch)
      }).catch(() => {})
    }
  }
  return sent
}
