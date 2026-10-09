import { SUPABASE_URL, SUPABASE_HEADERS } from "./shared"
import { fetchPublic } from "./safe-fetch"

// Weekly: the 5,000 best-known sites (the ones search shows most) are opened like a visitor would,
// homepage and indexed pages. Pages that answer 404 or 410 are listed in the log (not removed: page
// keys are often summary names, not real addresses). A domain that's gone (no longer exists, or refuses every
// connection) is checked again 10 minutes later, and only if it's still gone is the site hidden
// (status "unreachable", like reconvert.ts does). Slow answers, server errors and blocks (401, 403,
// 429, 5xx) never count: a busy site isn't a dead one. Claimed and native sites are never changed.
// DRY_RUN=1 only prints; LIMIT to check fewer.

const LIMIT = parseInt(process.env.LIMIT || "5000")
const DRY = !!process.env.DRY_RUN
const UA = "Mozilla/5.0 (compatible; Actuent/1.0; +https://docs.actuent.ai/bot)"
const CONCURRENCY = 16
const PAGES_PER_SITE = 6

type Check = "ok" | "gone" | "down"
async function check(url: string): Promise<Check> {
  try {
    let r = await fetchPublic(url, { method: "HEAD", headers: { "User-Agent": UA }, signal: AbortSignal.timeout(12000) })
    // Some servers don't do HEAD: ask again with GET.
    if (r && (r.status === 405 || r.status === 501 || r.status === 400)) r = await fetchPublic(url, { headers: { "User-Agent": UA, "Accept": "text/html" }, signal: AbortSignal.timeout(12000) })
    if (!r) return "ok" // not a public address (left to the other jobs)
    if (r.status === 404 || r.status === 410) return "gone"
    return "ok"
  } catch (e: any) {
    const code = String(e?.cause?.code || e?.code || "")
    return /ENOTFOUND|ECONNREFUSED/.test(code) ? "down" : "ok"
  }
}

async function pool<T>(items: T[], fn: (x: T) => Promise<void>) {
  let i = 0
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => { while (i < items.length) await fn(items[i++]) }))
}

async function patch(domain: string, body: object) {
  if (DRY) return
  await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?domain=eq.${encodeURIComponent(domain)}`, { method: "PATCH", headers: { ...SUPABASE_HEADERS, "Content-Type": "application/json", "Prefer": "return=minimal" }, body: JSON.stringify(body) }).catch(() => null)
}

async function main() {
  const sites: any[] = []
  for (let from = 0; from < LIMIT; from += 1000) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?select=domain,pages,owner_key,native&status=is.null&popularity_rank=not.is.null&order=popularity_rank.asc&limit=${Math.min(1000, LIMIT - from)}&offset=${from}`, { headers: SUPABASE_HEADERS })
    if (!r.ok) { console.error(`Couldn't load sites: ${r.status} ${await r.text()}`); process.exit(1) }
    const rows = await r.json()
    sites.push(...rows)
    if (rows.length < 1000) break
  }
  const open = sites.filter(s => !s.owner_key && !s.native)
  console.log(`Checking ${open.length} of the ${sites.length} best-known sites (claimed and native ones are left alone)`)
  const down: any[] = []
  let pagesRemoved = 0, sitesTrimmed = 0, checked = 0
  await pool(open, async s => {
    const home = await check(`https://${s.domain}/`)
    if (home === "down") { down.push(s); return }
    const paths = Object.keys(s.pages || {}).filter(p => p !== "/" && p.startsWith("/")).slice(0, PAGES_PER_SITE)
    const gone: string[] = []
    for (const p of paths) if (await check(`https://${s.domain}${p}`) === "gone") gone.push(p)
    if (++checked % 500 === 0) console.log(`…${checked} checked`)
    if (!gone.length) return
    // Reported, not removed: page keys are often names from Actuent's own summary ("/about") rather
    // than the site's real addresses, so a "not found" there doesn't mean the content is wrong.
    pagesRemoved += gone.length; sitesTrimmed++
    console.log(`${s.domain}: ${gone.length} page${gone.length === 1 ? "" : "s"} answer "not found" (${gone.join(", ")})`)
  })
  console.log(`${down.length} homepages didn't answer; checking them again in 10 minutes`)
  if (down.length) await new Promise(r => setTimeout(r, 10 * 60000))
  let hidden = 0
  await pool(down, async s => {
    if (await check(`https://${s.domain}/`) !== "down") return
    hidden++
    console.log(`unreachable ${s.domain}`)
    await patch(s.domain, { status: "unreachable", checked_at: new Date().toISOString() })
  })
  console.log(`Done${DRY ? " (dry run)" : ""}: ${pagesRemoved} pages answered \"not found\" on ${sitesTrimmed} sites (listed above, not removed), ${hidden} sites hidden as unreachable`)
}

main().catch(e => { console.error(e); process.exit(1) })
