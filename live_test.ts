// Weekly live test: the questions a Product Hunt visitor asks, answered the way they'd really be
// answered: an AI assistant (a Groq model with tool calling, standing in for Claude) gets Actuent's
// MCP tools from agents.actuent.ai, picks tools, calls them and writes the answer. Then simple checks:
// the right tool was used, the answer has what it should, and nothing went wrong ("busy", "rate
// limit", a city mix-up, "I can't browse"). The report goes to the job summary; the job fails below
// 80% so GitHub emails Alfred. Run: GROQ_API_KEY=… npx tsx live_test.ts   (ONLY=3,7 for some)
import { appendFileSync } from "fs"

const MCP = process.env.MCP_URL || "https://agents.actuent.ai/api/mcp"
// "cf:" = Cloudflare Workers AI (the crawler's existing key; roomier free limits), "groq:" = Groq.
const MODELS = (process.env.LIVE_TEST_MODELS || "cf:@cf/meta/llama-3.3-70b-instruct-fp8-fast,groq:openai/gpt-oss-120b,groq:openai/gpt-oss-20b").split(",")
const today = new Date().toISOString().slice(0, 10)
const SYSTEM = `You are an AI assistant chatting with a user. Today is ${today}. You have Actuent's tools for live information: use them for anything current, local, priced or event-related. Answer helpfully and concisely, naming the places, events or products you found.`

// [question, tool it should use (null: any Actuent tool; "none": general knowledge, no tool needed),
//  what the answer must mention (regex) or null]
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
  ["where is new balance from?", "none", /boston/i],
  ["latest news about openai", "actuent_news", null],
  ["what is actuent?", "none", /internet|live|search/i],
  ["best password manager", null, /1password|bitwarden|dashlane|proton|keeper/i],
  ["plan a saturday afternoon in copenhagen: lunch, a museum and drinks", null, /lunch/i]
]
const BAD = /rate limit|too many (people|requests)|catch (my|his) breath|temporarily (busy|unavailable)|dublin|i (can't|cannot|don't have the ability to) (browse|access the internet|search the web)|tool (error|failed)/i

async function mcp(method: string, params: any = {}): Promise<any> {
  const r = await fetch(MCP, { method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(60000) })
  const d: any = await r.json().catch(() => null)
  return d?.result
}

async function chat(model: string, messages: any[], tools: any[], opts: { tries?: number } = {}): Promise<any> {
  const cf = model.startsWith("cf:"), name = model.replace(/^(cf|groq):/, "")
  if (cf && !(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_AI_TOKEN)) throw new Error(`${model}: no Cloudflare key`)
  const url = cf ? `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/v1/chat/completions` : "https://api.groq.com/openai/v1/chat/completions"
  const key = cf ? process.env.CLOUDFLARE_AI_TOKEN : process.env.GROQ_API_KEY
  const r = await fetch(url, {
    method: "POST", headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: name, messages, tools, tool_choice: "auto", temperature: 0.2, max_tokens: 1200 }), signal: AbortSignal.timeout(90000)
  })
  // Rate limited: wait as long as it says (at most twice), then the next model takes over.
  if (r.status === 429 && (opts.tries || 0) < 2) {
    const wait = Math.min(30, Number(r.headers.get("retry-after")) || 15)
    await new Promise(res => setTimeout(res, wait * 1000))
    return chat(model, messages, tools, { tries: (opts.tries || 0) + 1 })
  }
  if (!r.ok) throw new Error(`${model}: ${r.status} ${(await r.text()).slice(0, 200)}`)
  return (await r.json()).choices[0].message
}

async function ask(question: string, tools: any[]): Promise<{ used: string[], answer: string, results: string }> {
  const messages: any[] = [{ role: "system", content: SYSTEM }, { role: "user", content: question }]
  const used: string[] = []
  let results = ""
  for (let turn = 0; turn < 8; turn++) {
    let msg: any = null
    for (const model of MODELS) { try { msg = await chat(model, messages, tools); break } catch (e) { console.log(String(e)) } }
    if (!msg) return { used, answer: "(no model answered)", results }
    if (!msg.tool_calls?.length) return { used, answer: String(msg.content || ""), results }
    // Only the standard fields go back (providers add their own, like "refusal", that others reject),
    // with arguments as a JSON string and an id on every call.
    msg.tool_calls = msg.tool_calls.map((c: any, i: number) => ({ id: c.id || `call_${turn}_${i}`, type: "function",
      function: { name: c.function?.name, arguments: typeof c.function?.arguments === "string" ? c.function.arguments : JSON.stringify(c.function?.arguments || {}) } }))
    messages.push({ role: "assistant", content: String(msg.content || ""), tool_calls: msg.tool_calls })
    for (const call of msg.tool_calls) {
      used.push(call.function.name)
      let args: any = {}
      try { args = JSON.parse(call.function.arguments || "{}") } catch {}
      const out = await mcp("tools/call", { name: call.function.name, arguments: args })
      const text = (out?.content || []).map((c: any) => c.text || "").join("\n").slice(0, 6000)
      results += text
      messages.push({ role: "tool", tool_call_id: call.id, content: text || "(empty)" })
      await new Promise(r => setTimeout(r, 4000)) // stays under the free limit of 20 tool calls a minute
    }
  }
  return { used, answer: "(still calling tools after 8 turns)", results }
}

async function main() {
  if (!process.env.GROQ_API_KEY && !process.env.CLOUDFLARE_AI_TOKEN) { console.error("Missing GROQ_API_KEY or CLOUDFLARE_AI_TOKEN"); process.exit(1) }
  const list = await mcp("tools/list")
  const tools = (list?.tools || []).map((t: any) => ({ type: "function", function: { name: t.name, description: String(t.description || "").slice(0, 350), parameters: t.inputSchema || { type: "object", properties: {} } } }))
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
    if (!used.length && tool !== "none") problems.push("used no Actuent tool")
    if (tool && tool !== "none" && !used.includes(tool)) problems.push(`expected ${tool}`)
    if (/^\((no model answered|still calling tools)/.test(answer)) problems.push("test couldn't finish (model limits)")
    if (must && !must.test(answer)) problems.push(`answer lacks ${must.source}`)
    const bad = `${answer}\n${results}`.match(BAD)?.[0]
    if (bad) problems.push(`"${bad}"`)
    if (!problems.length) passed++
    const line = `${problems.length ? "✗" : "✓"} ${question} — ${used.join(", ") || "no tools"} (${Math.round((Date.now() - started) / 1000)} s)${problems.length ? ` — ${problems.join("; ")}` : ""}`
    console.log(line + `\n    ${answer.replace(/\s+/g, " ").slice(0, 300)}`)
    await new Promise(r => setTimeout(r, 30000)) // the free token budget refills between questions
    rows.push(`| ${problems.length ? "✗" : "✓"} | ${question} | ${used.join(", ") || "–"} | ${problems.join("; ") || ""} | ${answer.replace(/\s+/g, " ").replace(/\|/g, "/").slice(0, 160)} |`)
  }
  const score = total ? Math.round(passed / total * 100) : 0
  console.log(`\n${passed} of ${total} passed (${score}%).`)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Live test: ${passed} of ${total} passed (${score}%)\n\n| | Question | Tools | Problems | Answer (start) |\n|---|---|---|---|---|\n${rows.join("\n")}\n`)
  if (score < 80) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
