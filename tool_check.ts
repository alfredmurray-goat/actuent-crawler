// Every Actuent MCP tool, called once with a real question: anything that errors, times out or comes
// back empty is flagged. Mornings before launch (tool_check.yml) for the free tools; with
// ACTUENT_TEST_KEY set (a Pro test key) the Pro tools are checked too. Nothing is sent or bought:
// contact_business only asks for a preview (no confirmed), execute_action only asks for confirmation.
import { appendFileSync } from "fs"

const MCP = "https://agents.actuent.ai/api/mcp"
const KEY = process.env.ACTUENT_TEST_KEY || ""

// tool → [arguments, what a good answer contains]
const CHECKS: Record<string, [any, RegExp]> = {
  actuent_search: [{ query: "cafes in brooklyn open now" }, /"results"/],
  actuent_get_actions: [{ domain: "notion.com" }, /"actions"/],
  actuent_get_page: [{ url: "https://www.allbirds.com/products/mens-tree-runners" }, /"readable": true/],
  actuent_about: [{ name: "Cat Power" }, /"Q\d+"/],
  actuent_compare: [{ domains: ["notion.com", "obsidian.md"] }, /notion/i],
  actuent_similar: [{ domain: "notion.com" }, /"sites"/],
  actuent_trending: [{}, /\w+/],
  actuent_news: [{ topic: "OpenAI" }, /"title"|"headline"|http/],
  actuent_nearby: [{ query: "coffee", location: "Brooklyn" }, /"places"/],
  actuent_plan: [{ location: "Nørrebro, Copenhagen", stops: ["dinner", "drinks"] }, /"itinerary"/],
  actuent_cart: [{ items: [{ url: "https://www.allbirds.com/products/mens-tree-runners", quantity: 1 }] }, /cart|checkout|shop/i],
  actuent_trip: [{ location: "Copenhagen", days: 1 }, /"days"|"day"/],
  actuent_find_service: [{ query: "haircut", location: "Copenhagen" }, /\w+/],
  actuent_ask_site: [{ domain: "notion.com", question: "is there a free plan" }, /"pages"/],
  actuent_events: [{ location: "Copenhagen", when: "this week" }, /"events_found": [1-9]/],
  actuent_summarise: [{ domain: "notion.com" }, /"summary"/],
  // Pro (only with ACTUENT_TEST_KEY)
  actuent_history: [{ limit: 1 }, /\w+/],
  actuent_watch_price: [{ action: "list" }, /"watching"/],
  actuent_watch_page: [{ action: "list" }, /"watching"/],
  actuent_alert_new: [{ action: "list" }, /\w+/],
  actuent_accounts: [{ action: "list" }, /\w+/],
  actuent_contact_business: [{ domain: "localilabs.com", kind: "question", text: "Tool check: preview only, nothing is sent." }, /"needs_confirmation": true/],
  actuent_execute_action: [{ domain: "api.actuent.ai", action_id: "suggest_site", input: { domain: "example.com" } }, /\w+/],
  actuent_action_status: [{ domain: "api.actuent.ai", status_url: "https://api.actuent.ai/api/suggest" }, /\w+/]
}

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
  for (const t of tools) {
    const pro = /PRO_ONLY|Pro/.test(JSON.stringify(t.securitySchemes || [])) && (t.securitySchemes || []).every((s: any) => s.type === "oauth2")
    const check = CHECKS[t.name]
    if (!check) { lines.push(`? ${t.name}: no check written`); continue }
    if (pro && !KEY) { lines.push(`- ${t.name}: Pro (skipped, no test key)`); continue }
    const { ms, error, text } = await call(t.name, check[0])
    const ok = !error && check[1].test(text)
    if (!ok) bad++
    lines.push(`${ok ? "✓" : "✗"} ${t.name} (${(ms / 1000).toFixed(1)} s)${ok ? "" : ` — ${text.replace(/\s+/g, " ").slice(0, 160)}`}`)
    await new Promise(res => setTimeout(res, 3500)) // under the free limit
  }
  const report = `${tools.length} tools, ${bad} problem${bad === 1 ? "" : "s"}\n${lines.join("\n")}`
  console.log(report)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, "```\n" + report + "\n```\n")
  if (bad) process.exitCode = 1
}

main().catch(e => { console.error(e); process.exit(1) })
