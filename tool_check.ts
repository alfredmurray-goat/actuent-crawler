// Every Actuent MCP tool, called once with a real question: anything that errors, times out or comes
// back empty is flagged. Mornings before launch (tool_check.yml) for the free tools; with
// ACTUENT_TEST_KEY set (a Pro test key) the Pro tools are checked too. Nothing is sent or bought:
// contact_business only asks for a preview (no confirmed), execute_action only asks for confirmation.
import { appendFileSync } from "fs"

const MCP = "https://agents.actuent.ai/api/mcp"
const KEY = process.env.ACTUENT_TEST_KEY || ""

// Every ability, as [tool, arguments, what a good answer contains, Pro only?]. The 13 listed tools and
// their kinds (search news/similar/trending, nearby service, plan trip, get_page summary/question,
// watch price/page/new_sites, account history/accounts/preferences). Answers are compact JSON, so
// patterns allow any spacing. Pro checks run only with ACTUENT_TEST_KEY.
const CHECKS: [string, any, RegExp, boolean?][] = [
  ["actuent_search", { query: "cafes in brooklyn open now" }, /"results"\s*:/],
  ["actuent_search", { kind: "news", query: "OpenAI" }, /"title"|"headline"|http/],
  ["actuent_search", { kind: "similar", domain: "notion.com" }, /"sites"\s*:/],
  ["actuent_search", { kind: "trending" }, /"trending/],
  ["actuent_events", { location: "Copenhagen", when: "this week" }, /"events_found"\s*:\s*[1-9]/],
  ["actuent_events", { location: "Copenhagen", from: "2026-01-01", to: "2026-01-02" }, /dates have passed/],
  ["actuent_nearby", { query: "coffee", location: "Brooklyn" }, /"places"\s*:/],
  ["actuent_nearby", { kind: "service", query: "haircut", location: "Copenhagen" }, /\w+/],
  ["actuent_plan", { location: "Nørrebro, Copenhagen", stops: ["dinner", "drinks"] }, /"itinerary"\s*:/],
  ["actuent_plan", { kind: "trip", location: "Copenhagen", days: 1 }, /"days?"\s*:/],
  ["actuent_get_page", { url: "https://www.allbirds.com/products/mens-tree-runners" }, /"readable"\s*:\s*true/],
  ["actuent_get_page", { domain: "notion.com" }, /"summary"\s*:/],
  ["actuent_get_page", { domain: "notion.com", question: "is there a free plan" }, /"pages"\s*:|"answer"/],
  ["actuent_actions", { domain: "notion.com" }, /"actions"\s*:/],
  ["actuent_about", { name: "Cat Power" }, /"Q\d+"/],
  ["actuent_compare", { domains: ["notion.com", "obsidian.md"] }, /notion/i],
  ["actuent_cart", { items: "FROM_SEARCH" }, /"checkouts"\s*:\s*\[\s*\{/],
  // Pro
  ["actuent_account", { kind: "history", limit: 1 }, /\w+/, true],
  ["actuent_account", { kind: "accounts", action: "list" }, /\w+/, true],
  ["actuent_account", { kind: "preferences", action: "list" }, /"remembered"/, true],
  ["actuent_watch", { kind: "price", action: "list" }, /"watching"/, true],
  ["actuent_watch", { kind: "page", action: "list" }, /"watching"/, true],
  ["actuent_watch", { kind: "new_sites", action: "list" }, /\w+/, true],
  ["actuent_contact_business", { domain: "localilabs.com", kind: "question", text: "Tool check: preview only, nothing is sent." }, /"needs_confirmation"\s*:\s*true/, true],
  ["actuent_actions", { domain: "api.actuent.ai", action_id: "suggest_site", input: { domain: "example.com" } }, /\w+/, true],
  ["actuent_actions", { domain: "api.actuent.ai", status_url: "https://api.actuent.ai/api/suggest" }, /\w+/, true]
]

async function call(name: string, args: any) {
  const started = Date.now()
  const r = await fetch(MCP, {
    method: "POST", headers: { "Content-Type": "application/json", ...(KEY ? { "Authorization": `Bearer ${KEY}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }), signal: AbortSignal.timeout(90000)
  }).catch(e => ({ ok: false, json: async () => ({ error: String(e) }) }) as any)
  const d: any = await r.json().catch(() => null)
  const text = (d?.result?.content || []).map((c: any) => c.text || "").join("\n")
  return { ms: Date.now() - started, error: !!d?.result?.isError || !d?.result, text }
}

async function main() {
  const list: any = await fetch(MCP, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }).then(r => r.json())
  const tools: any[] = list?.result?.tools || []
  const lines: string[] = []
  let bad = 0
  // actuent_feedback isn't called: it would file a real report.
  for (const t of tools) if (!CHECKS.some(c => c[0] === t.name)) lines.push(t.name === "actuent_feedback" ? `- ${t.name}: not called (it would file a real report)` : `? ${t.name}: no check written`)
  // A product Actuent tracks, for the cart check (any shop with cart links).
  const found = await call("actuent_search", { query: "allbirds tree runners" })
  let product = ""
  try { product = (JSON.parse(found.text).products || []).find((p: any) => p.cart_url)?.url || "" } catch {}
  for (const [name, args0, good, pro] of CHECKS) {
    if (pro && !KEY) { lines.push(`- ${name} ${JSON.stringify(args0).slice(0, 40)}: Pro (skipped, no test key)`); continue }
    const args = args0.items === "FROM_SEARCH" ? { items: product ? [{ url: product, quantity: 1 }] : [] } : args0
    if (args0.items === "FROM_SEARCH" && !product) { lines.push(`- ${name}: no shop product with a cart link in search right now (skipped)`); continue }
    const { ms, error, text } = await call(name, args)
    const ok = !error && good.test(text)
    if (!ok) bad++
    lines.push(`${ok ? "✓" : "✗"} ${name} ${JSON.stringify(args).slice(0, 50)} (${(ms / 1000).toFixed(1)} s)${ok ? "" : ` — ${text.replace(/\s+/g, " ").slice(0, 160)}`}`)
    await new Promise(res => setTimeout(res, 3500)) // under the free limit
  }
  const report = `${tools.length} tools listed, ${CHECKS.length} checks, ${bad} problem${bad === 1 ? "" : "s"}\n${lines.join("\n")}`
  console.log(report)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, "```\n" + report + "\n```\n")
  if (bad) process.exitCode = 1
}

main().catch(e => { console.error(e); process.exit(1) })
