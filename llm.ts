import Groq from "groq-sdk"

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

// Free LLM quota is the crawler's bottleneck, so it spreads work over every free model it can:
//   1. Groq: every chat model the key lists, except the ones reserved for live search
//      (actuent-public) so bulk crawling can't use up its quota. Override with GROQ_MODELS="a,b".
//   2. Google Gemini (free, no card) when GEMINI_API_KEY is set.   Model: GEMINI_MODEL
//   3. Mistral (free Experiment plan) when MISTRAL_API_KEY is set. Model: MISTRAL_MODEL
// Each target has its own cooldown after a rate limit.

type Target = { id: string, provider: "groq" | "openai-compatible", model: string, baseURL?: string, apiKey?: string }

const LIVE_SEARCH_MODELS = new Set(["openai/gpt-oss-20b", "openai/gpt-oss-120b", "llama-3.3-70b-versatile"])
const NON_CHAT = /whisper|tts|guard|prompt-guard|distil|playai|orpheus|compound/i
// Models that don't follow "return only JSON" instructions (they reply conversationally).
const UNRELIABLE_JSON = /allam/i

const SYSTEM_PROMPT = "You convert website content into LAWP JSON. Reply with a single JSON object only, no prose."
const MAX_TOKENS = 900

let targetsPromise: Promise<Target[]> | null = null

async function groqModels(): Promise<string[]> {
  if (process.env.GROQ_MODELS) return process.env.GROQ_MODELS.split(",").map(m => m.trim()).filter(Boolean)
  if (!process.env.GROQ_API_KEY) return []
  try {
    const list = await groq.models.list()
    return list.data
      .map((m: any) => m.id as string)
      .filter(id => !LIVE_SEARCH_MODELS.has(id) && !NON_CHAT.test(id) && !UNRELIABLE_JSON.test(id))
      .sort()
  } catch (e) {
    console.log(`llm: could not list Groq models: ${e}`)
    return []
  }
}

function getTargets(): Promise<Target[]> {
  targetsPromise ??= (async () => {
    const targets: Target[] = (await groqModels()).map(model => ({ id: `groq:${model}`, provider: "groq" as const, model }))
    if (process.env.GEMINI_API_KEY) targets.push({
      id: "gemini", provider: "openai-compatible", model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai", apiKey: process.env.GEMINI_API_KEY
    })
    if (process.env.MISTRAL_API_KEY) targets.push({
      id: "mistral", provider: "openai-compatible", model: process.env.MISTRAL_MODEL || "mistral-small-latest",
      baseURL: "https://api.mistral.ai/v1", apiKey: process.env.MISTRAL_API_KEY
    })
    console.log(`llm: crawler models: ${targets.map(t => t.id).join(", ") || "(none)"}`)
    return targets
  })()
  return targetsPromise
}

const blockedUntil = new Map<string, number>()

function retryAfterMs(message: string, header?: string | null): number {
  if (header && !isNaN(Number(header))) return Number(header) * 1000
  const match = message.match(/(?:try again|retry) in (?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/i)
  if (!match) return 5 * 60000
  const [, h, m, s] = match
  return ((Number(h) || 0) * 3600 + (Number(m) || 0) * 60 + (Number(s) || 0)) * 1000 || 5 * 60000
}

class LLMError extends Error {
  constructor(public status: number | undefined, message: string, public retryAfter?: string | null) { super(message) }
}

async function call(target: Target, prompt: string, timeoutMs: number): Promise<string | null> {
  const messages = [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: prompt }]
  if (target.provider === "groq") {
    try {
      const completion = await groq.chat.completions.create({
        model: target.model,
        messages,
        temperature: 0.1,
        response_format: { type: "json_object" },
        // Groq counts max tokens against per-minute limits (qwen's output limit is only 1000/min).
        max_tokens: MAX_TOKENS,
        // Qwen 3 "thinks" by default, which would use up the output budget.
        ...(target.model.startsWith("qwen/") ? { reasoning_effort: "none" } : {})
      } as any, { timeout: timeoutMs, maxRetries: 0 }) as any
      return completion.choices?.[0]?.message?.content || null
    } catch (e: any) {
      throw new LLMError(e?.status, String(e?.message || e), e?.headers?.["retry-after"])
    }
  }
  const res = await fetch(`${target.baseURL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${target.apiKey}` },
    body: JSON.stringify({ model: target.model, messages, temperature: 0.1, max_tokens: MAX_TOKENS, response_format: { type: "json_object" } }),
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!res.ok) throw new LLMError(res.status, (await res.text()).slice(0, 300), res.headers.get("retry-after"))
  const data = await res.json()
  return data.choices?.[0]?.message?.content || null
}

// Waits out short per-minute cooldowns (up to this long) instead of failing, so bulk jobs
// automatically pace themselves to free-tier rate limits.
const MAX_WAIT_MS = 90_000

// Returns the first model's answer, or null if every model failed or is blocked for longer.
export async function complete(prompt: string, timeoutMs: number = 15000): Promise<string | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const targets = await getTargets()
    for (const target of targets) {
      if ((blockedUntil.get(target.id) || 0) > Date.now()) continue
      try {
        const text = await call(target, prompt, timeoutMs)
        if (text) return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim()
        console.log(`llm: ${target.id} returned no content`)
      } catch (e: any) {
        const status = e?.status
        const message = String(e?.message || e)
        if (status === 429) blockedUntil.set(target.id, Date.now() + retryAfterMs(message, e?.retryAfter))
        else if (status === 400 || status === 401 || status === 403 || status === 404) blockedUntil.set(target.id, Date.now() + 60 * 60000)
        console.log(`llm: ${target.id} failed (${status ?? "no status"}): ${message.replace(/.*on_demand` on /, "").slice(0, 200)}`)
      }
    }
    const nextFree = Math.min(...targets.map(t => blockedUntil.get(t.id) || 0))
    const wait = nextFree - Date.now()
    if (!targets.length || wait <= 0 || wait > MAX_WAIT_MS) return null
    await new Promise(r => setTimeout(r, wait + 500))
  }
  return null
}
