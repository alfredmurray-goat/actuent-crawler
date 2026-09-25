import fs from "fs"
import readline from "readline"
import { SUPABASE_URL, SUPABASE_HEADERS, robotsAllows } from "./shared"
import { USER_AGENT } from "./robots"

// Indexes key subpages (/pricing, /about, /contact) of the most popular indexed sites, in Tranco
// order. No LLM: the page text is summarised directly, so it never competes for Groq quota.
// Sites are marked with subpages_crawled_at so each is done once.

const PATHS = ["/pricing", "/about", "/contact"]
const TOP = parseInt(process.env.SUBPAGE_TOP || "20000")
const TIME_BUDGET_MS = parseInt(process.env.TIME_BUDGET_MIN || "120") * 60000
const CONCURRENCY = 5
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

function clean(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")          // markdown images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")        // markdown links → text
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/[#*_>`|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

// Returns null when the page is missing, blocked, or just redirects to the homepage.
async function fetchPage(domain: string, path: string): Promise<{ title: string, content: string } | null> {
  try {
    const res = await fetch(`https://${domain}${path}`, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(8000) })
    const finalPath = new URL(res.url).pathname.replace(/\/+$/, "") || "/"
    if (res.ok && (res.headers.get("content-type") || "").includes("html")) {
      if (finalPath === "/") return null
      const html = await res.text()
      const title = clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "") || path.slice(1)
      const body = clean(html.match(/<body[\s\S]*<\/body>/i)?.[0] || html)
      return body.length >= 80 ? { title: title.slice(0, 120), content: body.slice(0, 700) } : null
    }
    if (res.status === 404 || res.status === 410) return null
  } catch {}
  // Blocked or not HTML: try Jina Reader, which renders JavaScript sites.
  try {
    const res = await fetch(`https://r.jina.ai/https://${domain}${path}`, { headers: { "Accept": "text/plain" }, signal: AbortSignal.timeout(12000) })
    if (!res.ok) return null
    const text = await res.text()
    if (/returned error \d{3}/i.test(text)) return null
    const source = text.match(/^URL Source:\s*(\S+)/m)?.[1]
    if (source && (new URL(source).pathname.replace(/\/+$/, "") || "/") === "/") return null
    const title = text.match(/^Title:\s*(.+)$/m)?.[1]?.trim() || path.slice(1)
    const body = clean(text.split(/Markdown Content:/)[1] || text)
    return body.length >= 80 ? { title: title.slice(0, 120), content: body.slice(0, 700) } : null
  } catch { return null }
}

async function candidates(domains: string[]): Promise<any[]> {
  const list = encodeURIComponent(domains.map(d => `"${d}"`).join(","))
  const r = await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?select=domain,pages&domain=in.(${list})&subpages_crawled_at=is.null&owner_key=is.null&actions=neq.%5B%5D`, { headers: SUPABASE_HEADERS })
  if (!r.ok) throw new Error(`Could not load sites: ${r.status} ${await r.text()}`)
  return r.json()
}

async function processSite(site: any): Promise<number> {
  const pages = { ...(site.pages || {}) }
  let found = 0
  for (const path of PATHS) {
    if (pages[path] || !await robotsAllows(site.domain, path)) continue
    const page = await fetchPage(site.domain, path)
    if (!page) continue
    found++
    pages[path] = { title: page.title, content: page.content.slice(0, 300) }
    await fetch(`${SUPABASE_URL}/rest/v1/lawp_pages?on_conflict=full_url`, {
      method: "POST",
      headers: { ...SUPABASE_HEADERS, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates" },
      body: JSON.stringify({ domain: site.domain, path, full_url: `${site.domain}${path}`, title: page.title, content: page.content, actions: [], updated_at: new Date().toISOString() })
    })
  }
  const r = await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?domain=eq.${encodeURIComponent(site.domain)}`, {
    method: "PATCH",
    headers: { ...SUPABASE_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ ...(found ? { pages } : {}), subpages_crawled_at: new Date().toISOString() })
  })
  if (!r.ok) throw new Error(await r.text())
  return found
}

async function main() {
  const start = Date.now()
  const domains = await topDomains("./tranco_PY69J.csv")
  console.log(`Checking subpages for the top ${domains.length} sites`)
  let sites = 0, pagesFound = 0
  for (let i = 0; i < domains.length && Date.now() - start < TIME_BUDGET_MS; i += CHUNK) {
    const todo = await candidates(domains.slice(i, i + CHUNK))
    let index = 0
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (index < todo.length) {
        const site = todo[index++]
        try {
          const n = await processSite(site)
          sites++; pagesFound += n
          if (n) console.log(`+${n} ${site.domain}`)
        } catch (e) { console.log(`error ${site.domain}: ${e}`) }
      }
    }))
  }
  console.log(`Done in ${Math.round((Date.now() - start) / 60000)} min. ${sites} sites checked, ${pagesFound} subpages indexed.`)
}

main()
