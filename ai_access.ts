// AI bot access: reads each site's robots.txt and records which AI crawlers and assistants it
// blocks from the whole site (GPTBot, ClaudeBot, PerplexityBot…). Many sites block agents without
// knowing it; site pages show the result with a fix. Writes only lawp_sites.ai_access — never
// updated_at. Rechecks every 30 days. Needs list_five.sql.

const SUPABASE_URL = "https://bcmwypjrahtxogytsvuc.supabase.co"
const KEY = process.env.SUPABASE_SERVICE_KEY!
const HEADERS = { "apikey": KEY, "Authorization": `Bearer ${KEY}` }
const TIME_BUDGET_MS = parseInt(process.env.TIME_BUDGET_MIN || "60") * 60000
const CONCURRENCY = 15

if (!KEY) { console.error("Missing SUPABASE_SERVICE_KEY"); process.exit(1) }
process.on("uncaughtException", (e: any) => {
  if (e?.code === "ERR_ASSERTION" && /undici/.test(String(e?.stack))) return
  console.error(e); process.exit(1)
})

// Who they belong to, for the site page.
export const AI_BOTS: Record<string, string> = {
  "GPTBot": "OpenAI (training)", "OAI-SearchBot": "ChatGPT search", "ChatGPT-User": "ChatGPT (browsing for a user)",
  "ClaudeBot": "Anthropic (training)", "Claude-SearchBot": "Claude search", "Claude-User": "Claude (browsing for a user)",
  "PerplexityBot": "Perplexity search", "Perplexity-User": "Perplexity (browsing for a user)",
  "Google-Extended": "Google Gemini (training)", "Applebot-Extended": "Apple Intelligence (training)",
  "Amazonbot": "Amazon / Alexa", "meta-externalagent": "Meta AI", "CCBot": "Common Crawl (used by many AI models)",
  "Bytespider": "ByteDance", "cohere-ai": "Cohere", "DuckAssistBot": "DuckDuckGo AI answers", "MistralAI-User": "Mistral Le Chat",
  "Actuent": "Actuent (this search engine)"
}

type Group = { agents: string[], rules: { allow: boolean, path: string }[] }

export function parseRobots(text: string): Group[] {
  const groups: Group[] = []
  let current: Group | null = null, lastWasAgent = false
  for (const line of text.split(/\r?\n/)) {
    const m = line.replace(/#.*/, "").trim().match(/^([A-Za-z-]+)\s*:\s*(.*)$/)
    if (!m) continue
    const key = m[1].toLowerCase(), value = m[2].trim()
    if (key === "user-agent") {
      if (!current || !lastWasAgent) { current = { agents: [], rules: [] }; groups.push(current) }
      current.agents.push(value.toLowerCase()); lastWasAgent = true
    } else if ((key === "allow" || key === "disallow") && current) {
      if (value || key === "allow") current.rules.push({ allow: key === "allow", path: value })
      lastWasAgent = false
    } else lastWasAgent = false
  }
  return groups
}

// Blocked from the whole site: the most specific group for the bot disallows "/" without allowing it back.
export function blockedEverywhere(groups: Group[], bot: string): boolean {
  const name = bot.toLowerCase()
  const group = groups.find(g => g.agents.some(a => a !== "*" && name.includes(a))) || groups.find(g => g.agents.includes("*"))
  if (!group) return false
  const rootBlocked = group.rules.some(r => !r.allow && (r.path === "/" || r.path === "/*"))
  const rootAllowed = group.rules.some(r => r.allow && (r.path === "/" || r.path === "/*" || r.path === ""))
  return rootBlocked && !rootAllowed
}

async function check(domain: string): Promise<object> {
  try {
    const r = await fetch(`https://${domain}/robots.txt`, { headers: { "User-Agent": "Mozilla/5.0 (compatible; Actuent/1.0; +https://docs.actuent.ai/bot)" }, signal: AbortSignal.timeout(7000) })
    const type = r.headers.get("content-type") || ""
    if (!r.ok || type.includes("html")) return { robots_txt: false, blocked: [], checked_at: new Date().toISOString() }
    const groups = parseRobots((await r.text()).slice(0, 200_000))
    return {
      robots_txt: true,
      blocked: Object.keys(AI_BOTS).filter(b => blockedEverywhere(groups, b)),
      blocks_everyone: blockedEverywhere(groups, "SomeOtherBot"),
      checked_at: new Date().toISOString()
    }
  } catch { return { robots_txt: null, blocked: [], checked_at: new Date().toISOString() } }
}

async function main() {
  const start = Date.now()
  let done = 0, withBlocks = 0, lastDomain = ""
  const stale = new Date(Date.now() - 30 * 86400000).toISOString()
  while (Date.now() - start < TIME_BUDGET_MS) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?select=domain&or=${encodeURIComponent(`(ai_access.is.null,ai_access->>checked_at.lt.${stale})`)}&domain=gt.${encodeURIComponent(lastDomain)}&order=domain.asc&limit=300`, { headers: HEADERS })
    if (!r.ok) { console.log(`Could not load sites: ${r.status} ${await r.text()}`); break }
    const rows: { domain: string }[] = await r.json()
    if (!rows.length) break
    lastDomain = rows[rows.length - 1].domain
    let index = 0
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (index < rows.length) {
        const { domain } = rows[index++]
        const access: any = await check(domain)
        if (access.blocked.length) withBlocks++
        await fetch(`${SUPABASE_URL}/rest/v1/lawp_sites?domain=eq.${encodeURIComponent(domain)}`, {
          method: "PATCH", headers: { ...HEADERS, "Content-Type": "application/json", "Prefer": "return=minimal" }, body: JSON.stringify({ ai_access: access })
        }).catch(() => {})
      }
    }))
    done += rows.length
    if (done % 3000 < 300) console.log(`${done} checked, ${withBlocks} block at least one AI bot`)
  }
  console.log(`Done in ${Math.round((Date.now() - start) / 60000)} min: ${done} checked, ${withBlocks} block at least one AI bot`)
}

if (process.argv[1]?.endsWith("ai_access.ts")) main().catch(e => { console.error(e); process.exit(1) })
