import type { IncomingMessage, ServerResponse } from 'node:http'

export interface FakeRequestOptions {
  /** HTTP method; defaults to GET, matching the read routes. */
  method?: string
  /** Lowercase-keyed request headers, as Node itself exposes them. */
  headers?: Record<string, string>
}

/**
 * A minimal fake `IncomingMessage`: async-iterable over body chunks, plus the
 * `url`, `method`, and `headers` the route handler actually reads.
 */
export function fakeRequest(
  url: string,
  bodyChunks: string[] = [],
  options: FakeRequestOptions = {},
): IncomingMessage {
  async function* iterate() {
    for (const chunk of bodyChunks) yield Buffer.from(chunk, 'utf8')
  }
  const req: any = {
    url,
    method: options.method ?? 'GET',
    headers: options.headers ?? {},
    [Symbol.asyncIterator]: iterate,
  }
  return req as IncomingMessage
}

/** A POST request, the form every mutating route requires. */
export function fakePostRequest(
  url: string,
  bodyChunks: string[] = [],
  headers: Record<string, string> = {},
): IncomingMessage {
  return fakeRequest(url, bodyChunks, { method: 'POST', headers })
}

export interface CapturedResponse {
  status: number | null
  headers: Record<string, unknown> | null
  /** Headers set individually via `setHeader`, separate from the `writeHead` block. */
  setHeaders: Record<string, unknown>
  body: string
  json(): unknown
}

/** A minimal fake `ServerResponse` that captures what `writeHead`/`setHeader`/`end` were called with. */
export function fakeResponse(): { res: ServerResponse, captured: CapturedResponse } {
  const captured: CapturedResponse = {
    status: null,
    headers: null,
    setHeaders: {},
    body: '',
    json() { return JSON.parse(this.body) },
  }
  const res: any = {
    setHeader(name: string, value: unknown) {
      captured.setHeaders[String(name).toLowerCase()] = value
      return res
    },
    writeHead(status: number, headers: Record<string, unknown>) {
      captured.status = status
      captured.headers = headers
      return res
    },
    end(body?: string) {
      if (typeof body === 'string') captured.body = body
    },
  }
  return { res: res as ServerResponse, captured }
}
