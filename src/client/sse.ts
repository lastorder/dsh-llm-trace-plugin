/**
 * Raw Server-Sent-Events body parsing/pretty-printing.
 *
 * Reassembling fragmented delta chunks into one complete, readable structure
 * is handled by the per-provider adapters under `sse-merge/`; see
 * `sse-merge/index.ts` for the entry point (`mergeSseChunks`).
 *
 * @module dsh-llm-trace-plugin/client/sse
 */

/**
 * Parse a raw SSE body into one plain object per frame, so the whole stream
 * can be read with the same JSON view as a request body.
 *
 * Frames are separated by blank lines. Every SSE field becomes a key under
 * its protocol name: `data:` holds the parsed JSON when the payload is
 * parseable and the raw string otherwise (so `[DONE]` survives as
 * `"data": "[DONE]"`), and `event:` / `id:` / `retry:` sit alongside it.
 * Comment lines (`: keep-alive`) become `"comment"`. Nothing is dropped — an
 * unparseable or unexpected line is still visible in the result.
 *
 * A frame carrying repeated `data:` lines follows the SSE spec and joins them
 * with newlines before the JSON parse is attempted.
 *
 * @param text - the raw event-stream body.
 * @returns one object per frame, in wire order.
 */
export function parseSseFrames(text: string): Record<string, unknown>[] {
  if (typeof text !== 'string' || text.length === 0) return []
  const frames: Record<string, unknown>[] = []
  // Normalize CRLF so frame splitting works on either line ending.
  const blocks = text.replace(/\r\n/g, '\n').split(/\n{2,}/)
  for (const block of blocks) {
    if (block.trim() === '') continue
    const frame: Record<string, unknown> = {}
    const dataLines: string[] = []
    const comments: string[] = []
    for (const line of block.split('\n')) {
      if (line === '') continue
      if (line.startsWith(':')) {
        comments.push(line.slice(1).trim())
        continue
      }
      const sep = line.indexOf(':')
      const field = sep === -1 ? line : line.slice(0, sep)
      // Per the SSE spec a single leading space after the colon is stripped.
      const value = sep === -1 ? '' : line.slice(sep + 1).replace(/^ /, '')
      if (field === 'data') dataLines.push(value)
      else frame[field] = value
    }
    if (comments.length > 0) frame.comment = comments.length === 1 ? comments[0] : comments
    if (dataLines.length > 0) {
      const payload = dataLines.join('\n')
      // Keep the raw string when the payload isn't JSON, so sentinels like
      // `[DONE]` stay visible instead of being silently dropped.
      let parsed: unknown
      try {
        parsed = JSON.parse(payload)
      } catch {
        parsed = payload
      }
      frame.data = parsed
    }
    if (Object.keys(frame).length > 0) frames.push(frame)
  }
  return frames
}

/**
 * jq-style pretty-print of a raw SSE body: reformats only the JSON payload of
 * each `data:` line, leaving frame structure — blank separators,
 * `event:`/`id:`/`retry:` fields, comment lines, and non-JSON sentinels like
 * `data: [DONE]` — completely untouched. A `data:` payload that isn't
 * parseable JSON passes through verbatim; a malformed body is never silently
 * rewritten into something that looks valid.
 * @param text - the raw SSE body.
 * @returns the same frame sequence with JSON payloads re-indented.
 */
export function prettySseText(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text || ''
  const lines = text.split('\n')
  const out: string[] = []
  for (const line of lines) {
    const match = /^data:\s?(.*)$/.exec(line)
    if (match === null) {
      out.push(line)
      continue
    }
    const payload = match[1]
    let parsed: unknown
    try {
      parsed = JSON.parse(payload)
    } catch {
      out.push(line)
      continue
    }
    const pretty = JSON.stringify(parsed, null, 2)
    // Re-indent every continuation line so the frame's payload still reads
    // as one visually distinct block under its own "data: " lead-in.
    const indented = pretty.split('\n').map((l, i) => (i === 0 ? l : '  ' + l)).join('\n')
    out.push('data: ' + indented)
  }
  return out.join('\n')
}
