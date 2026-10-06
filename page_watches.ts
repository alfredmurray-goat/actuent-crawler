import { createHash } from "crypto"
import { SUPABASE_URL, SUPABASE_HEADERS } from "./shared"
import { sendEmail, esc, lawpyImg } from "./email"
import { isPublicHost } from "./safe-fetch"

// Daily: page watches (actuent_watch_page, list_thirty.sql). Each watched page is read live through
// Actuent's page reader; when it changed, or the phrase appeared or disappeared, the user gets one
// email (and their webhook is called). The first check only records how the page is now.

const JSON_HEADERS = { ...SUPABASE_HEADERS, "Content-Type": "application/json" }

async function email(keyHash: string): Promise<string | null> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/api_keys?select=email&key_hash=eq.${keyHash}`, { headers: SUPABASE_HEADERS }).catch(() => null)
  const [row] = r?.ok ? await r.json() : []
  return row?.email || null
}

async function main() {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/page_watches?select=*&order=checked_at.asc.nullsfirst&limit=500`, { headers: SUPABASE_HEADERS })
  if (!r.ok) { console.log(`page_watches not available (run list_thirty.sql): ${r.status}`); return }
  const watches: any[] = await r.json()
  console.log(`${watches.length} page watches`)
  let alerted = 0
  for (const w of watches) {
    const page: any = await fetch(`https://api.actuent.ai/api/search?read=${encodeURIComponent(w.url)}`, { headers: { "User-Agent": "Actuent-Alerts/1.0" }, signal: AbortSignal.timeout(30000) }).then(x => x.json()).catch(() => null)
    await new Promise(res => setTimeout(res, 4000)) // gentle: under the free per-minute limit
    if (!page?.readable) { console.log(`${w.url}: not readable (${page?.reason || "no answer"})`); continue }
    const text = String(page.text || "").toLowerCase().replace(/\s+/g, " ")
    const hash = createHash("sha256").update(text).digest("hex").slice(0, 32)
    const seen = w.phrase ? text.includes(String(w.phrase).toLowerCase()) : null
    let happened = false
    if (w.watch_for === "change") happened = !!w.last_hash && w.last_hash !== hash
    if (w.watch_for === "appears") happened = seen === true && w.last_seen === false
    if (w.watch_for === "disappears") happened = seen === false && w.last_seen === true
    await fetch(`${SUPABASE_URL}/rest/v1/page_watches?id=eq.${w.id}`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ last_hash: hash, last_seen: seen, checked_at: new Date().toISOString(), ...(happened ? { alerted_at: new Date().toISOString() } : {}) }) }).catch(() => null)
    if (!happened || w.alerted_at && w.watch_for !== "change") continue
    const what = w.watch_for === "change" ? "has changed" : w.watch_for === "appears" ? `now says “${w.phrase}”` : `no longer says “${w.phrase}”`
    const title = w.label || page.title || w.url
    const to = await email(w.api_key)
    if (to) await sendEmail(to, `${title} ${what}`, `${lawpyImg("dance")}<p>The page you asked Actuent to watch ${esc(what)}:</p><p><a href="${esc(w.url)}">${esc(title)}</a></p><p style="color:#666;font-size:13px">You're getting this because you asked your AI assistant to watch this page with Actuent. Ask it to stop watching to turn this off.</p>`)
    if (w.webhook_url) {
      try { if (await isPublicHost(new URL(w.webhook_url).hostname)) await fetch(w.webhook_url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event: "page_watch", url: w.url, watch_for: w.watch_for, phrase: w.phrase || null, title }), signal: AbortSignal.timeout(8000) }) } catch {}
    }
    alerted++
    console.log(`${w.url}: ${what}`)
  }
  console.log(`Done: ${alerted} alerts`)
}

main().catch(e => { console.error(e); process.exit(1) })
