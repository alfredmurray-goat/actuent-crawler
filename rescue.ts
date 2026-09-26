import { toLAWP } from "./shared"
import { heuristicLAWP } from "./heuristic"
import { fetchLlmsTxt, llmsTxtSummary } from "./llmstxt"
import { sitemapPaths } from "./sitemap"

// Before the mass crawler saves a site as minimal ("Website at …"), it tries harder, the same way
// the reconvert job would later — LLM first, then the rule-based converter — but with more sources:
//   1. The page rendered by Jina Reader (JavaScript sites whose raw HTML is an empty shell)
//   2. www. and http:// versions of the homepage (sites that only answer on one of them)
//   3. The site's llms.txt (its own summary and page list, written for AI)
//   4. Its sitemap (key pages like /pricing, /contact, /book become links the rules can use)
// Returns a real LAWP, or null when the site really has nothing usable.

const UA = "Mozilla/5.0 (compatible; Actuent/1.0; +https://docs.actuent.ai/bot)"

type Source = { text: string, raw: string, isHtml: boolean, from: string }

function htmlToText(raw: string): string {
  return raw.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
}

async function fetchHtml(url: string): Promise<Source | null> {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": "text/html" }, signal: AbortSignal.timeout(8000) })
    if (!r.ok || !(r.headers.get("content-type") || "").includes("html")) return null
    const raw = (await r.text()).slice(0, 400_000)
    const text = htmlToText(raw)
    return text.length >= 200 ? { text: text.slice(0, 3000), raw, isHtml: true, from: url } : null
  } catch { return null }
}

async function fetchJina(url: string): Promise<Source | null> {
  try {
    const r = await fetch(`https://r.jina.ai/${url}`, {
      headers: { "Accept": "text/plain", ...(process.env.JINA_API_KEY ? { "Authorization": `Bearer ${process.env.JINA_API_KEY}` } : {}) },
      signal: AbortSignal.timeout(15000)
    })
    if (!r.ok) return null
    const raw = (await r.text()).slice(0, 100_000)
    if (raw.length < 200 || /returned error \d{3}|Target URL returned error/i.test(raw)) return null
    return { text: raw.replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\s+/g, " ").slice(0, 3000), raw, isHtml: false, from: `jina:${url}` }
  } catch { return null }
}

// llms.txt as Jina-style markdown, so the rule-based converter can read its title and links.
function llmsAsMarkdown(domain: string, llms: string): Source {
  const title = llms.match(/^\s*#\s+(.+)$/m)?.[1]?.trim() || domain
  const summary = llmsTxtSummary(llms) || ""
  const raw = `Title: ${title}\n\nMarkdown Content:\n${summary}\n\n${llms}`
  return { text: `${title}. ${summary} ${llms}`.replace(/\s+/g, " ").slice(0, 3000), raw, isHtml: false, from: "llms.txt" }
}

// Sitemap pages as markdown links: the rules turn /pricing, /contact, /book… into actions.
async function sitemapLinks(domain: string): Promise<string> {
  try {
    const paths = await Promise.race([sitemapPaths(domain), new Promise<string[]>(r => setTimeout(() => r([]), 12000))])
    return paths.map(p => `[${p.split("/").filter(Boolean).pop()?.replace(/[-_]/g, " ") || p}](https://${domain}${p})`).join("\n")
  } catch { return "" }
}

function usable(lawp: any): boolean {
  return Array.isArray(lawp?.actions) && lawp.actions.length > 0
}

export async function rescue(domain: string, page: { text: string, raw: string, isHtml: boolean } | null, useLlm: boolean): Promise<{ lawp: any, conversion: "llm" | "heuristic", from: string } | null> {
  const sources: Source[] = []
  // 1. JavaScript sites: the raw HTML had too little to go on; the rendered page usually has more.
  if (page?.isHtml) { const j = await fetchJina(`https://${domain}`); if (j) sources.push(j) }
  // 2. Homepage blocked or down: other addresses for the same site.
  if (!page) {
    const bare = domain.replace(/^www\./, "")
    for (const url of [`https://www.${bare}`, `http://${bare}`, `http://www.${bare}`]) {
      if (url.includes(`//${domain}`) && url.startsWith("https")) continue
      const s = await fetchHtml(url) || await fetchJina(url)
      if (s) { sources.push(s); break }
    }
  }
  // 3. The site's own summary for AI.
  const llms = await fetchLlmsTxt(domain)
  if (llms) sources.push(llmsAsMarkdown(domain, llms))
  if (!sources.length && !page) return null

  // 4. Key pages from the sitemap, as extra links for every source.
  const links = await sitemapLinks(domain)

  for (const s of sources) {
    if (useLlm) {
      const lawp: any = await toLAWP(domain, s.text + (links ? `\n\nPages: ${links.replace(/\n/g, " ")}` : "")).catch(() => null)
      if (usable(lawp)) return { lawp, conversion: "llm", from: s.from }
    }
    const rules = heuristicLAWP(domain, s.isHtml ? s.raw + links.replace(/\[([^\]]*)\]\(([^)]*)\)/g, '<a href="$2">$1</a>') : `${s.raw}\n${links}`, s.isHtml)
    if (usable(rules)) return { lawp: rules, conversion: "heuristic", from: s.from }
  }
  // The original page plus sitemap links, when the page alone had no actions.
  if (page && links) {
    const rules = heuristicLAWP(domain, page.isHtml ? page.raw + links.replace(/\[([^\]]*)\]\(([^)]*)\)/g, '<a href="$2">$1</a>') : `${page.raw}\n${links}`, page.isHtml)
    if (usable(rules)) return { lawp: rules, conversion: "heuristic", from: "sitemap" }
  }
  return null
}
