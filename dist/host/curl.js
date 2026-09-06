/**
 * Render a captured wire record as a runnable `curl` command, with the
 * redacted `authorization` header rebuilt from a real, resolvable credential
 * whenever one can be found.
 *
 * @module dsh-llm-trace-plugin/host/curl
 */
/**
 * Single-quote one shell argument, POSIX-safe (bash/zsh/sh): close the quote,
 * emit an escaped literal quote, reopen — the standard `'\''` trick. Handles
 * embedded quotes and newlines without any character being interpreted.
 */
export function shQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
/**
 * Double-quote one shell argument, escaping only the characters double quotes
 * still give special meaning to (`\`, `"`, `` ` ``, `$`). Unlike {@link shQuote}
 * this permits `$VAR`-style expansion to survive inside the result — which is
 * the point: {@link buildCurl} uses it only for the one header line that must
 * let a real environment variable expand at run time.
 */
export function dqEscape(value) {
    return String(value).replace(/[\\"`$]/g, '\\$&');
}
/**
 * Headers never worth putting on an explicit `-H` line: curl derives
 * content-length itself, and host-hop-by-hop fields don't belong on a replay.
 */
export const CURL_SKIP_HEADERS = new Set(['content-length', 'host', 'connection']);
/**
 * Plugin-owned, provider-neutral override: export this once and every copied
 * curl command references it, whatever provider or host the record is for.
 * Deliberately not named after any one provider's own key — a wire record can
 * be a self-hosted gateway, `pi-ai`'s fully user-configured routes, or
 * anything else this plugin has no fixed mapping for, and the point of this
 * variable is to work identically in every one of those cases.
 */
export const CURL_OVERRIDE_ENV = 'DSH_CURL_KEY';
/**
 * Known fixed provider endpoints this plugin can map to the conventional
 * credential env-var name their shipped adapter defaults to, purely as an
 * automatic convenience when that provider's own key is already configured.
 * Anything else (self-hosted gateways, pi-ai's fully user-configured routes)
 * has no entry here — correlating a wire record back to whichever `apiKeyEnv`
 * a user's settings configured for it isn't reliable from the URL alone, so
 * this stays a narrow, explicit allowlist rather than a guess. Those hosts
 * still get the universal `DSH_CURL_KEY` override below.
 */
export const KNOWN_HOST_CREDENTIAL_ENV = new Map([
    ['api.deepseek.com', 'DEEPSEEK_API_KEY'],
]);
/**
 * Resolve the real credential value for one request's host, checking two
 * independent sources and preferring the more explicit one:
 *
 * 1. `DSH_CURL_KEY` in the process environment — a manual, provider-neutral
 *    override that works for ANY host, including ones this plugin has no
 *    fixed mapping for. Checked first so an explicit override always wins.
 * 2. The host's known provider credential (`ctx.credentials` first, so a
 *    stored/UI-configured key is honored, then the plain environment
 *    variable) — the same two layers `dsh-llm-deepseek`'s own `resolveApiKey`
 *    checks — only when the host is in {@link KNOWN_HOST_CREDENTIAL_ENV}.
 *
 * The curl command always references `$DSH_CURL_KEY` when no value was found
 * by either path (never a provider-specific name the user may not recognize),
 * so exporting that one variable and re-running the copied command works
 * regardless of which of these two paths would have supplied it.
 */
export async function resolveRealApiKey(url, credentials) {
    const override = process.env[CURL_OVERRIDE_ENV];
    if (typeof override === 'string' && override.length > 0)
        return { value: override };
    let host;
    try {
        host = new URL(url).host;
    }
    catch {
        return undefined;
    }
    const providerEnvName = KNOWN_HOST_CREDENTIAL_ENV.get(host);
    if (providerEnvName === undefined)
        return undefined;
    if (credentials !== undefined) {
        try {
            const hit = await credentials.resolve(providerEnvName);
            if (hit !== undefined && hit.value.length > 0)
                return { value: hit.value };
        }
        catch {
            // fall through to the ambient environment
        }
    }
    const ambient = process.env[providerEnvName];
    if (typeof ambient === 'string' && ambient.length > 0)
        return { value: ambient };
    return undefined;
}
/**
 * Render one wire-trace record as a runnable `curl` command.
 *
 * The stored `authorization` header is always the redacted placeholder (this
 * plugin never keeps a real secret at rest), so the header line is rebuilt
 * fresh here, one of two ways:
 *
 * - a real value was resolved (from `DSH_CURL_KEY` or a known provider's own
 *   credential): inline it directly, single-quoted like every other header —
 *   paste-and-run.
 * - nothing was found: render `"authorization: Bearer $DSH_CURL_KEY"` —
 *   double-quoted so the shell expands the variable at run time, always this
 *   one plugin-owned name regardless of which provider or host the record is
 *   for.
 *
 * Never the literal `***redacted***` text, which would not even look like a
 * plausible key.
 */
export function buildCurl(record, resolved) {
    const lines = [`curl ${shQuote(record.request.url)} \\`, `  -X ${shQuote(record.request.method)} \\`];
    for (const [key, value] of Object.entries(record.request.headers)) {
        if (CURL_SKIP_HEADERS.has(key))
            continue;
        if (key === 'authorization') {
            if (resolved !== undefined) {
                lines.push(`  -H ${shQuote(`authorization: Bearer ${resolved.value}`)} \\`);
            }
            else {
                lines.push(`  -H "${dqEscape(`authorization: Bearer `)}$${CURL_OVERRIDE_ENV}" \\`);
            }
            continue;
        }
        lines.push(`  -H ${shQuote(`${key}: ${value}`)} \\`);
    }
    if (record.request.bodyText) {
        lines.push(`  --data-raw ${shQuote(record.request.bodyText)}`);
    }
    else {
        lines[lines.length - 1] = lines[lines.length - 1].replace(/ \\$/, '');
    }
    return lines.join('\n');
}
