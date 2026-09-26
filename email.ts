// Transactional email via Resend (free tier) for the crawler jobs: price-drop alerts and weekly
// score emails. Off unless RESEND_API_KEY is set (GitHub secret).

const RESEND_API_KEY = process.env.RESEND_API_KEY
const EMAIL_FROM = process.env.EMAIL_FROM || "Actuent <hello@actuent.ai>"

export const emailEnabled = !!RESEND_API_KEY

export function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!))
}

export async function sendEmail(to: string, subject: string, html: string, headers?: Record<string, string>): Promise<boolean> {
  if (!RESEND_API_KEY || !to) return false
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject, html, reply_to: "support@localilabs.com", ...(headers ? { headers } : {}) })
    })
    if (!r.ok) console.log(`email failed: ${r.status} ${await r.text()}`)
    return r.ok
  } catch (e) { console.log(`email failed: ${e}`); return false }
}
