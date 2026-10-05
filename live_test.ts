// Weekly live test: the questions a Product Hunt visitor asks, answered the way they'd really be
// answered: an AI assistant (a Groq model with tool calling, standing in for Claude) gets Actuent's
// MCP tools from agents.actuent.ai, picks tools, calls them and writes the answer. Then simple checks:
// the right tool was used, the answer has what it should, and nothing went wrong ("busy", "rate
// limit", a city mix-up, "I can't browse"). The report goes to the job summary; the job fails below
// 80% so GitHub emails Alfred. Run: GROQ_API_KEY=… npx tsx live_test.ts   (ONLY=3,7 for some)
import { appendFileSync } from "fs"

const MCP = process.env.MCP_URL || "https://agents.actuent.ai/api/mcp"
const MODELS = (process.env.LIVE_TEST_MODELS || "openai/gpt-oss-120b,llama-3.3-70b-versatile").split(",")
const today = new Date().toISOString().slice(0, 10)
const SYSTEM = `You are an AI assistant chatting with a user. Today is ${today}. You have Actuent's tools for live information: use them for anything current, local, priced or event-related. Answer helpfully and concisely, naming the places, events or products you found.`

// [question, tool it should use (or null: any/none), what the answer must mention (regex) or null]
const Q: [string, string | null, RegExp | null][] = [
  ["what's on in copenhagen tonight?", "actuent_events", null],
  ["any concerts in new york this weekend?", "actuent_events", null],
  ["jazz concerts in copenhagen this week", "actuent_events", /jazz/i],
  ["comedy shows in chicago this week", "actuent_events", /den theatre|comedy/i],
  ["kids activities in copenhagen tomorrow", "actuent_events", /bibliotek|library/i],
  ["markets in copenhagen this weekend", "actuent_events", /marked|market/i],
  ["coffee shop open now in williamsburg brooklyn", null, null],
  ["find me a vegan restaurant in copenhagen", null, /vegan|plant/i],
  ["best tacos in austin", null, /taco/i],
  ["museums open today in london", null, /museum/i],
  ["what's the cheapest Hoka Clifton right now?", null, /\$|€|usd|eur|price/i],
  ["how much are airpods pro?", null, /\$|usd|price/i],
  ["does notion have a free plan?", null, /free/i],
  ["does spotify have a student discount", null, /student/i],
  ["compare notion vs obsidian", null, /obsidian/i],
  ["where is new balance from?", null, /boston/i],
  ["latest news about openai", "actuent_news", null],
  ["what is actuent?", null, /internet|live|search/i],
  ["best password manager", null, /1password|bitwarden|dashlane|proton|keeper/i],
  ["plan a saturday afternoon in copenhagen: lunch, a museum and drinks", null, /lunch/i]
]
const BAD = /rate limit|too many (people|requests)|catch (my|his) breath|temporarily (busy|unavailable)|dublin|i (can't|cannot|don't have the ability to) (browse|access the internet|search the web)|tool (error|failed)/i

async function mcp(method: string, params: any = {}): Promise<any> {
  const r = await fetch(MCP, { method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(60000) })
  const d: any = await r.json().catch(() => null)
  return d?.result
}

async function chat(model: string, messages: any[], tools: any[]): Promise<any> {
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST", headers: { "Authorization": `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, tools, tool_choice: "auto", temperature: 0.2, max_tokens: 1200 }), signal: AbortSignal.timeout(90000)
  })
  if (!r.ok) throw new Error(`${model}: ${r.status} ${(await r.text()).slice(0, 200)}`)
  return (await r.json()).choices[0].message
}

async function ask(question: string, tools: any[]): Promise<{ used: string[], answer: string, results: string }> {
  const messages: any[] = [{ role: "system", content: SYSTEM }, { role: "user", content: question }]
  const used: string[] = []
  let results = ""
  for (let turn = 0; turn < 5; turn++) {
    let msg: any = null
    for (const model of MODELS) { try { msg = await chat(model, messages, tools); break } catch (e) { console.log(String(e)) } }
    if (!msg) return { used, answer: "(no model answered)", results }
    messages.push(msg)
    if (!msg.tool_calls?.length) return { used, answer: String(msg.content || ""), results }
    for (const call of msg.tool_calls) {
      used.push(call.function.name)
      let args: any = {}
      try { args = JSON.parse(call.function.arguments || "{}") } catch {}
      const out = await mcp("tools/call", { name: call.function.name, arguments: args })
      const text = (out?.content || []).map((c: any) => c.text || "").join("\n").slice(0, 12000)
      results += text
      messages.push({ role: "tool", tool_call_id: call.id, content: text || "(empty)" })
      await new Promise(r => setTimeout(r, 4000)) // stays under the free limit of 20 tool calls a minute
    }
  }
  return { used, answer: "(still calling tools after 5 turns)", results }
}

async function main() {
  if (!process.env.GROQ_API_KEY) { console.error("Missing GROQ_API_KEY"); process.exit(1) }
  const list = await mcp("tools/list")
  const tools = (list?.tools || []).map((t: any) => ({ type: "function", function: { name: t.name, description: String(t.description || "").slice(0, 1000), parameters: t.inputSchema || { type: "object", properties: {} } } }))
  if (!tools.length) { console.error("Couldn't list Actuent's tools"); process.exit(1) }
  const only = process.env.ONLY?.trim() ? process.env.ONLY.split(",").map(Number) : null
  const rows: string[] = []
  let passed = 0, total = 0
  for (const [i, [question, tool, must]] of Q.entries()) {
    if (only && !only.includes(i + 1)) continue
    total++
    const started = Date.now()
    const { used, answer, results } = await ask(question, tools).catch(e => ({ used: [] as string[], answer: `(error: ${e})`, results: "" }))
    const problems: string[] = []
    if (!used.length) problems.push("used no Actuent tool")
    if (tool && !used.includes(tool)) problems.push(`expected ${tool}`)
    if (must && !must.test(answer)) problems.push(`answer lacks ${must.source}`)
    const bad = `${answer}\n${results}`.match(BAD)?.[0]
    if (bad) problems.push(`"${bad}"`)
    if (!problems.length) passed++
    const line = `${problems.length ? "✗" : "✓"} ${question} — ${used.join(", ") || "no tools"} (${Math.round((Date.now() - started) / 1000)} s)${problems.length ? ` — ${problems.join("; ")}` : ""}`
    console.log(line + `\n    ${answer.replace(/\s+/g, " ").slice(0, 300)}`)
    rows.push(`| ${problems.length ? "✗" : "✓"} | ${question} | ${used.join(", ") || "–"} | ${problems.join("; ") || ""} | ${answer.replace(/\s+/g, " ").replace(/\|/g, "/").slice(0, 160)} |`)
  }
  const score = total ? Math.round(passed / total * 100) : 0
  console.log(`\n${passed} of ${total} passed (${score}%).`)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Live test: ${passed} of ${total} passed (${score}%)\n\n| | Question | Tools | Problems | Answer (start) |\n|---|---|---|---|---|\n${rows.join("\n")}\n`)
  if (score < 80) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
