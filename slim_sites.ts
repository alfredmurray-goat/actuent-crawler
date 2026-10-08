import { SUPABASE_URL, SUPABASE_HEADERS } from "./shared"
import { databaseFullness } from "./quiet"

// Smaller site rows, same meaning: the same keyword listed twice in an action's intents (or more than
// 10 of them), an action listed twice, pages with no text, and subpages whose text is just the
// homepage's again. Claimed and native sites are left exactly as their owners made them. Each night
// one slice of the alphabet (by domain), at most MAX rows, and it stops at 85% full: every rewritten
// row takes new space until the database is vacuumed. DRY_RUN=1 only measures.

const DRY = !!process.env.DRY_RUN
const MAX = parseInt(process.env.MAX || "8000")
const SLICES = "0abcdefghijklmnopqrstuvwxyz".split("")
const slice = process.env.SLICE || SLICES[Math.floor(Date.now() / 86400000) % SLICES.length]

export function slimSite(s: { domain: string, pages: any, actions: any }): { pages: any, actions: any } {
  const actions: any[] = []
  for (const a of Array.isArray(s.actions) ? s.actions : []) {
    if (!a || typeof a !== "object" || actions.some(x => x.id === a.id && x.url === a.url)) continue
    const intent = Array.isArray(a.intent) ? [...new Set(a.intent.map((x: any) => String(x).toLowerCase().replace(/\s+/g, " ").trim()).filter(Boolean))].slice(0, 10) : a.intent
    actions.push(intent ? { ...a, intent } : a)
  }
  const pages: Record<string, any> = {}
  const home = String(s.pages?.["/"]?.content || "").trim()
  for (const [path, p] of Object.entries<any>(s.pages || {})) {
    const content = String(p?.content || "").trim(), title = String(p?.title || "").trim()
    if (path !== "/" && !content && (!title || title === s.domain)) continue
    if (path !== "/" && home && content === home) continue
    pages[path] = p
  }
  return { pages, actions }
}

async function main() {
  const next = SLICES[SLICES.indexOf(slice) + 1]
  let cursor = slice === "0" ? "" : slice, done = 0, changed = 0, saved = 0
  console.log(`Slice "${slice}"${DRY ? " (dry run)" : ""}`)
  const full = DRY ? null : await databaseFullness()
  if (full != null && full >= 0.85) { console.log(`Database ${Math.round(full * 100)}% full: run vacuum full first, nothing changed`); return }
  while (done < MAX) {
    if (!DRY && changed && changed % 1000 === 0) { const f = await databaseFullness(); if (f != null && f >= 0.85) { console.log(`Database ${Math.round(f * 100)}% full: stopping`); break } }
    const r = await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?select=domain,pages,actions,owner_key,native&domain=gt.${encodeURIComponent(cursor)}${next ? `&domain=lt.${next}` : ""}&order=domain.asc&limit=500`, { headers: SUPABASE_HEADERS, signal: AbortSignal.timeout(30000) })
    if (!r.ok) { console.log(`Couldn't read sites: ${r.status} ${await r.text()}`); break }
    const rows: any[] = await r.json()
    if (!rows.length) break
    for (const s of rows) {
      done++
      if (s.owner_key || s.native) continue
      const slim = slimSite(s)
      const diff = JSON.stringify(s.pages).length + JSON.stringify(s.actions).length - JSON.stringify(slim.pages).length - JSON.stringify(slim.actions).length
      if (diff < 40) continue
      changed++; saved += diff
      if (!DRY) await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?domain=eq.${encodeURIComponent(s.domain)}`, { method: "PATCH", headers: { ...SUPABASE_HEADERS, "Content-Type": "application/json", "Prefer": "return=minimal" }, body: JSON.stringify(slim) }).catch(() => null)
    }
    cursor = rows[rows.length - 1].domain
  }
  console.log(`${done} sites read, ${changed} slimmer, ${(saved / 1048576).toFixed(2)} MB less${done ? ` (≈${Math.round(saved / done)} bytes a site)` : ""}${DRY ? " — dry run, nothing changed" : ""}`)
}

if (process.argv[1]?.endsWith("slim_sites.ts")) main().catch(e => { console.error(e); process.exit(1) })
