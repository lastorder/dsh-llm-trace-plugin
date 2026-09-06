import type { IncomingMessage, ServerResponse } from 'node:http'

/** A minimal fake `IncomingMessage`: async-iterable over body chunks, plus a `url`. */
export function fakeRequest(url: string, bodyChunks: string[] = []): IncomingMessage {
  async function* iterate() {
    for (const chunk of bodyChunks) yield Buffer.from(chunk, 'utf8')
  }
  const req: any = {
    url,
    [Symbol.asyncIterator]: iterate,
  }
  return req as IncomingMessage
}

export interface CapturedResponse {
  status: number | null
  headers: Record<string, unknown> | null
  body: string
  json(): unknown
}

/** A minimal fake `ServerResponse` that captures what `writeHead`/`end` were called with. */
export function fakeResponse(): { res: ServerResponse, captured: CapturedResponse } {
  const captured: CapturedResponse = {
    status: null,
    headers: null,
    body: '',
    json() { return JSON.parse(this.body) },
  }
  const res: any = {
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
