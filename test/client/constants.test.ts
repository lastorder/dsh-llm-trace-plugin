import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ROUTE } from '../../src/client/constants.js'
import { ROUTE_PREFIX } from '../../src/host/constants.js'

// The host and the browser half are separate builds and `src/shared/` is
// type-only, so the route prefix cannot be imported across the boundary. It is
// duplicated on purpose; this test is what stops the duplication from rotting.
//
// Drift here is not a compile error — it is a viewer whose every request 404s
// with no diagnostic, which is exactly the failure the removed `routePrefix`
// config option used to cause.
test('the client ROUTE matches the host ROUTE_PREFIX exactly', () => {
  assert.equal(ROUTE, ROUTE_PREFIX)
})

test('the route prefix is absolute and carries no trailing slash', () => {
  // `api-client.ts` builds URLs as `ROUTE + '/' + method`, and the host slices
  // the prefix off the pathname; a trailing slash would break both.
  assert.ok(ROUTE.startsWith('/'))
  assert.ok(!ROUTE.endsWith('/'))
})
