/**
 * Client-side constants for the Wire Trace viewer.
 *
 * @module dsh-llm-trace-plugin/client/constants
 */

/**
 * The route prefix the host half serves this plugin's JSON API on.
 *
 * MUST stay identical to `ROUTE_PREFIX` in `src/host/constants.ts`. The two
 * halves are separate builds and `src/shared/` is type-only by design, so
 * this value cannot be imported across the boundary — it is duplicated
 * deliberately and pinned by `test/client/constants.test.ts`, which fails if
 * the two ever drift apart.
 */
export const ROUTE = '/llm-wire-trace'
export const STYLE_ID = 'dsh-llm-trace-plugin/wire-trace.css'

export const PATH_SEP = '\u0000'
export const ROOT_PATH = '$'
export const LONG_STRING = 120
export const MAX_ROWS = 20000
