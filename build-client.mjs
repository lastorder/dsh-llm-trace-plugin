#!/usr/bin/env node
/**
 * Bundle the TypeScript client entry into a single classic-script file the
 * runtime can load as-is: `window.__ModuleLoader__.load({ id, factory })`.
 *
 * esbuild bundles every `src/client/**` module (plus the shared type-only
 * imports, which contribute no runtime code) into one IIFE. The result is
 * still plain, un-transformed-by-the-runtime JavaScript — esbuild's output
 * format ('iife') requires no external module loader and needs no `<script
 * type="module">`, matching how this plugin's `dsh.client` config expects a
 * single classic script.
 *
 * @module build-client
 */

import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

await build({
  entryPoints: [join(here, 'src/client/entry.ts')],
  outfile: join(here, 'dist/client.js'),
  bundle: true,
  format: 'iife',
  target: 'es2022',
  platform: 'browser',
  legalComments: 'none',
  banner: {
    js: '// dsh-llm-trace-plugin: compiled from src/client/**/*.ts — see README.md "Development".',
  },
})

console.log('built dist/client.js')
