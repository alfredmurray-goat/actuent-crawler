import { SUPABASE_URL, SUPABASE_HEADERS } from "./shared"

// What changed on a site between two crawls, in plain words, saved to lawp_diffs for the change
// feeds (api.actuent.ai/changes.rss and /site/<domain>/changes.rss). Only changes people would care
// about: the name, pages added or removed, page titles, and actions added or removed. Page summaries
// are left out on purpose: the AI rewrites them a little on every crawl.

const pageName = (path: string, page: any) => page?.title ? `"${String(page.title).slice(0, 60)}"` : path

export function describeChanges(before: any, after: any): { changes: any, description: string } | null {
  const lines: string[] = [], changes: any = {}
  if (before?.name && after?.name && before.name !== after.name) { changes.name = { from: before.name, to: after.name }; lines.push(`Renamed from ${before.name} to ${after.name}`) }
  const was = before?.pages || {}, now = after?.pages || {}
  const added = Object.keys(now).filter(p => !was[p]), removed = Object.keys(was).filter(p => !now[p])
  const retitled = Object.keys(now).filter(p => was[p] && was[p].title && now[p].title && was[p].title !== now[p].title)
  if (added.length) { changes.pages_added = added; lines.push(`New page${added.length > 1 ? "s" : ""}: ${added.slice(0, 4).map(p => pageName(p, now[p])).join(", ")}${added.length > 4 ? ` and ${added.length - 4} more` : ""}`) }
  if (removed.length) { changes.pages_removed = removed; lines.push(`Page${removed.length > 1 ? "s" : ""} gone: ${removed.slice(0, 4).map(p => pageName(p, was[p])).join(", ")}${removed.length > 4 ? ` and ${removed.length - 4} more` : ""}`) }
  if (retitled.length) { changes.pages_retitled = retitled; lines.push(`Retitled: ${retitled.slice(0, 3).map(p => `${pageName(p, was[p])} → ${pageName(p, now[p])}`).join("; ")}`) }
  const ids = (x: any) => new Set<string>((x?.actions || []).map((a: any) => a.id).filter(Boolean))
  const a0 = ids(before), a1 = ids(after)
  const aAdded = [...a1].filter(i => !a0.has(i)), aRemoved = [...a0].filter(i => !a1.has(i))
  const actionName = (x: any, id: string) => (x?.actions || []).find((a: any) => a.id === id)?.name || id
  if (aAdded.length) { changes.actions_added = aAdded; lines.push(`New action${aAdded.length > 1 ? "s" : ""} for agents: ${aAdded.map(i => actionName(after, i)).join(", ")}`) }
  if (aRemoved.length) { changes.actions_removed = aRemoved; lines.push(`No longer offered: ${aRemoved.map(i => actionName(before, i)).join(", ")}`) }
  return lines.length ? { changes, description: lines.join(". ") + "." } : null
}

export async function recordChange(domain: string, before: any, after: any): Promise<boolean> {
  if (!before?.pages) return false
  const found = describeChanges(before, after)
  if (!found) return false
  const slim = (x: any) => ({ name: x?.name ?? null, pages: Object.fromEntries(Object.entries(x?.pages || {}).map(([p, v]: any) => [p, { title: v?.title ?? null }])), actions: (x?.actions || []).map((a: any) => ({ id: a.id, name: a.name })) })
  const r = await fetch(`${SUPABASE_URL}/rest/v1/lawp_diffs`, {
    method: "POST", headers: { ...SUPABASE_HEADERS, "Content-Type": "application/json", "Prefer": "return=minimal" },
    body: JSON.stringify({ domain, previous: slim(before), current: slim(after), changes: found.changes, description: found.description })
  }).catch(() => null)
  return !!r?.ok
}
