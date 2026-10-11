/**
 * Small `fetch`-based client for this plugin's own `/llm-wire-trace` routes,
 * plus a couple of unrelated browser helpers (download, clipboard copy) used
 * by the detail pane's toolbar.
 *
 * @module dsh-llm-trace-plugin/client/api-client
 */

import { ROUTE } from './constants.js'

/**
 * Thrown by {@link apiGet}/{@link apiPost} for a non-OK response, carrying the
 * HTTP status alongside the message — e.g. a 404 almost always means this
 * exact route does not exist on the running host (a stale host build after a
 * plugin update added a route; `dsh web` must be restarted to pick up
 * host-side changes, see the README's "Install" notes), which a caller may
 * want to treat differently from any other failure without parsing the
 * message string.
 */
export class ApiError extends Error {
  readonly status: number
  constructor(method: string, status: number) {
    super('llm-wire-trace ' + method + ' failed: HTTP ' + status)
    this.name = 'ApiError'
    this.status = status
  }
}

export async function apiGet(method: string, params?: Record<string, unknown>): Promise<any> {
  const url = new URL(ROUTE + '/' + method, window.location.origin)
  for (const key of Object.keys(params ?? {})) {
    const value = (params as Record<string, unknown>)[key]
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
  }
  const response = await fetch(url.toString(), { headers: { accept: 'application/json' } })
  if (!response.ok) throw new ApiError(method, response.status)
  return response.json()
}

export async function apiPost(method: string, body?: unknown): Promise<any> {
  const response = await fetch(ROUTE + '/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  if (!response.ok) throw new ApiError(method, response.status)
  return response.json()
}

export function download(name: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

export function copy(text: string): void {
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text)
}
