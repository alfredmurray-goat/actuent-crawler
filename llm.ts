import Groq from "groq-sdk"

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

// Groq's free tier gives each model its own daily token quota, so when one model is used up
// (or unavailable) we move on to the next. Live search (actuent-public) keeps these models to
// itself so bulk crawling can't use up its quota; the crawler uses every other chat model the
// key has access to. Override with GROQ_MODELS="a,b,c".
const LIVE_SEARCH_MODELS = new Set(["openai/gpt-oss-20b", "openai/gpt-oss-120b", "llama-3.3-70b-versatile"])
const NON_CHAT = /whisper|tts|guard|prompt-guard|distil|playai|orpheus|compound/i

let modelsPromise: Promise<string[]> | null = null

function getModels(): Promise<string[]> {
  if (process.env.GROQ_MODELS) {
    return Promise.resolve(process.env.GROQ_MODELS.split(",").map(m => m.trim()).filter(Boolean))
  }
  modelsPromise ??= (async () => {
    try {
      const list = await groq.models.list()
      const models = list.data
        .map((m: any) => m.id as string)
        .filter(id => !LIVE_SEARCH_MODELS.has(id) && !NON_CHAT.test(id))
        .sort()
      console.log(`llm: crawler models: ${models.join(", ") || "(none)"}`)
      return models
    } catch (e) {
      console.log(`llm: could not list models: ${e}`)
      return []
    }
  })()
  return modelsPromise
}

// Model → time it can be tried again. Per serverless instance, which is enough to avoid
// re-hitting an exhausted model on every request.
const blockedUntil = new Map<string, number>()

function retryAfterMs(message: string): number {
  const match = message.match(/try again in (?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/)
  if (!match) return 5 * 60000
  const [, h, m, s] = match
  return ((Number(h) || 0) * 3600 + (Number(m) || 0) * 60 + (Number(s) || 0)) * 1000 || 5 * 60000
}

// Waits out short per-minute cooldowns (up to this long) instead of failing, so bulk jobs
// automatically pace themselves to Groq's free-tier rate limits.
const MAX_WAIT_MS = 90_000

// Returns the first model's answer, or null if every model failed or is blocked for longer.
export async function complete(prompt: string, timeoutMs: number = 15000): Promise<string | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const models = await getModels()
    for (const model of models) {
      if ((blockedUntil.get(model) || 0) > Date.now()) continue
      try {
        const completion = await groq.chat.completions.create({
          model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.1,
          // Groq counts max tokens against per-minute limits (qwen's output limit is only
          // 1000/min), so keep it just above what a LAWP document needs.
          max_tokens: 900,
          // Qwen 3 "thinks" by default, which would use up the output budget.
          ...(model.startsWith("qwen/") ? { reasoning_effort: "none" } : {})
        } as any, { timeout: timeoutMs, maxRetries: 0 }) as any
        const text = completion.choices?.[0]?.message?.content
        if (text) return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim()
      } catch (e: any) {
        const status = e?.status
        const message = String(e?.message || e)
        if (status === 429) blockedUntil.set(model, Date.now() + retryAfterMs(message))
        else if (status === 400 || status === 403 || status === 404) blockedUntil.set(model, Date.now() + 60 * 60000)
        console.log(`llm: ${model} failed (${status ?? "no status"}): ${message.slice(0, 160)}`)
      }
    }
    const nextFree = Math.min(...models.map(m => blockedUntil.get(m) || 0))
    const wait = nextFree - Date.now()
    if (!models.length || wait <= 0 || wait > MAX_WAIT_MS) return null
    await new Promise(r => setTimeout(r, wait + 500))
  }
  return null
}
