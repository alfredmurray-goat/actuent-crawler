// Events from a venue's calendar feed (iCalendar / .ics, often linked as webcal://), for venues whose
// events pages have no schema.org data. Used by venueEvents (osm_businesses.ts). Only upcoming
// events (next 120 days), at most 100 per feed.

export type IcalEvent = { url: string, name: string, start_date: string, end_date: string | null, venue: string | null, description: string | null }

// Calendar feeds linked from a page: <link rel="alternate" type="text/calendar">, .ics links, webcal:// links.
export function calendarLinks(html: string, pageUrl: string): string[] {
  const out = new Set<string>()
  for (const m of html.matchAll(/<link[^>]+type=["']text\/calendar["'][^>]*>/gi)) { const h = m[0].match(/href=["']([^"']+)["']/i); if (h) out.add(h[1]) }
  for (const m of html.matchAll(/href=["']((?:webcal|https?):\/\/[^"']+?\.ics(?:\?[^"']*)?|[^"':]+?\.ics(?:\?[^"']*)?|webcal:\/\/[^"']+)["']/gi)) out.add(m[1])
  return [...out].map(u => { try { return new URL(u.replace(/^webcal:/i, "https:"), pageUrl).toString() } catch { return "" } }).filter(u => u.startsWith("https://")).slice(0, 3)
}

// A local date-time in a time zone → UTC.
function zoned(y: number, mo: number, d: number, h: number, mi: number, zone: string): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi)
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(guess)).map(p => [p.type, p.value]))
    const shown = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute))
    return new Date(guess - (shown - guess))
  } catch { return new Date(guess) }
}

function icalDate(value: string, params: string, fallbackZone: string | null): Date | null {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/)
  if (!m) return null
  const [, y, mo, d, h = "00", mi = "00", , z] = m
  if (z) return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi))
  const zone = (params.match(/TZID=([^;:]+)/i) || [])[1] || fallbackZone
  return zone ? zoned(+y, +mo, +d, +h, +mi, zone) : new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi))
}

const unescape = (t: string) => t.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").replace(/\s+/g, " ").trim()

export function parseIcal(text: string, feedUrl: string, now = new Date()): IcalEvent[] {
  // Long lines are folded: a line starting with a space continues the one before.
  const lines = text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/)
  const calZone = (text.match(/^X-WR-TIMEZONE:(.+)$/m) || [])[1]?.trim() || null
  const out: IcalEvent[] = []
  let cur: Record<string, { value: string, params: string }> | null = null
  const until = now.getTime() + 120 * 86400000
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { cur = {}; continue }
    if (line === "END:VEVENT" && cur) {
      const start = cur.DTSTART ? icalDate(cur.DTSTART.value, cur.DTSTART.params, calZone) : null
      const end = cur.DTEND ? icalDate(cur.DTEND.value, cur.DTEND.params, calZone) : null
      const name = cur.SUMMARY ? unescape(cur.SUMMARY.value).slice(0, 200) : ""
      if (start && name && start.getTime() >= now.getTime() - 3 * 3600000 && start.getTime() <= until && !/^(cancelled|canceled|aflyst)/i.test(name)) {
        const url = cur.URL?.value && /^https?:\/\//.test(cur.URL.value) ? cur.URL.value : `${feedUrl}#${encodeURIComponent(cur.UID?.value || name)}`
        out.push({ url, name, start_date: start.toISOString(), end_date: end ? end.toISOString() : null, venue: cur.LOCATION ? unescape(cur.LOCATION.value).slice(0, 200) : null, description: cur.DESCRIPTION ? unescape(cur.DESCRIPTION.value).slice(0, 400) : null })
      }
      cur = null
      if (out.length >= 100) break
      continue
    }
    if (!cur) continue
    const m = line.match(/^([A-Z-]+)((?:;[^:]*)?):(.*)$/)
    if (m && !(m[1] in cur)) cur[m[1]] = { value: m[3], params: m[2] }
  }
  return out
}
