/**
 * Wire-level HTTP parsing helpers: header redaction, request description, and
 * safe JSON/body clipping. Kept free of any store/persistence concerns so it
 * can be unit-tested in isolation.
 *
 * @module dsh-llm-trace-plugin/host/http-utils
 */
/** Clip a string to a character budget, reporting whether it was cut. */
export function clip(text, max) {
    if (text.length <= max)
        return { text, chars: text.length, truncated: false };
    return { text: text.slice(0, max), chars: text.length, truncated: true };
}
/**
 * Normalize a Headers-like value (Headers instance, plain object, or entry
 * array) into a plain lowercase-keyed object, redacting `authorization`.
 */
export function redactedHeaders(headers) {
    const out = {};
    const set = (key, value) => {
        const k = String(key).toLowerCase();
        out[k] = k === 'authorization' ? 'Bearer ***redacted***' : String(value);
    };
    if (headers === null || headers === undefined)
        return out;
    // Array MUST be checked before the forEach duck-type below: every array
    // has its own `.forEach`, so an entry array would otherwise be routed into
    // the Headers-style branch and iterated as (value, index) pairs instead of
    // (key, value) pairs — silently producing numeric-index keys ("0", "1", …)
    // instead of the real header names.
    if (Array.isArray(headers)) {
        for (const entry of headers)
            if (Array.isArray(entry) && entry.length === 2)
                set(entry[0], entry[1]);
        return out;
    }
    const maybeForEach = headers.forEach;
    if (typeof maybeForEach === 'function') {
        ;
        headers.forEach((value, key) => set(key, value));
        return out;
    }
    if (typeof headers === 'object') {
        for (const key of Object.keys(headers))
            set(key, headers[key]);
        return out;
    }
    return out;
}
/**
 * Read the outgoing user-agent from a fetch call's normalized headers, or
 * from a `Request` instance when the caller passed one instead of a plain init.
 */
export function outgoingUserAgent(input, init) {
    const fromInit = init && init.headers ? redactedHeaders(init.headers)['user-agent'] : undefined;
    if (typeof fromInit === 'string')
        return fromInit;
    if (input !== null && typeof input === 'object' && typeof input.headers !== 'undefined') {
        const fromRequest = redactedHeaders(input.headers)['user-agent'];
        if (typeof fromRequest === 'string')
            return fromRequest;
    }
    return '';
}
/**
 * Extract method, URL, and body text from a fetch call, supporting both the
 * `fetch(url, init)` and `fetch(new Request(url, init))` calling forms.
 */
export function describeRequest(input, init) {
    const isRequestLike = input !== null && typeof input === 'object' && typeof input.url === 'string';
    const url = isRequestLike ? input.url : String(input);
    const method = (init && init.method) || (isRequestLike ? input.method : undefined) || 'GET';
    const headers = redactedHeaders((init && init.headers) || (isRequestLike ? input.headers : undefined));
    let bodyText = null;
    const body = init ? init.body : undefined;
    if (typeof body === 'string')
        bodyText = body;
    // Request-object bodies and streamed/binary bodies are deliberately left
    // unread here: reading them would consume the only copy. Both shipped
    // adapters pass a JSON string body directly, which is the case this
    // plugin exists to capture.
    return { method: String(method), url, headers, bodyText };
}
/** Best-effort JSON parse for display; never throws. */
export function tryParseJson(text) {
    if (typeof text !== 'string' || text.length === 0)
        return null;
    try {
        return JSON.parse(text);
    }
    catch {
        return null;
    }
}
