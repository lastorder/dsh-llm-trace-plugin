/**
 * Small `fetch`-based client for this plugin's own `/llm-wire-trace` routes,
 * plus a couple of unrelated browser helpers (download, clipboard copy) used
 * by the detail pane's toolbar.
 *
 * @module dsh-llm-trace-plugin/client/api-client
 */

import { ROUTE } from './constants.js'

export async function apiGet(method: string, params?: Record<string, unknown>): Promise<any> {
  const url = new URL(ROUTE + '/' + method, window.location.origin)
  for (const key of Object.keys(params ?? {})) {
    const value = (params as Record<string, unknown>)[key]
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
  }
  const response = await fetch(url.toString(), { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error('llm-wire-trace ' + method + ' failed: HTTP ' + response.status)
  return response.json()
}

export async function apiPost(method: string, body?: unknown): Promise<any> {
  const response = await fetch(ROUTE + '/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  if (!response.ok) throw new Error('llm-wire-trace ' + method + ' failed: HTTP ' + response.status)
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
