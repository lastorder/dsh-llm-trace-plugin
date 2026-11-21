# Persistence: design and data format

English | [中文](persistence.zh.md)

How Wire Trace records are stored on disk since 0.6.0: the layout, the byte-level format of every file, the algorithms behind it, and the limits. For what the user sees (location, budget, clearing), read the main README's [Persistence](../README.md#persistence); for how the modules fit together, [`architecture.md`](architecture.md). The code is `src/host/persistence/` — `naming.ts` (names, no I/O), `codec.ts` (what is stored, no I/O), `archive.ts` (all the I/O) and `constants.ts` — plus the in-memory half in `src/host/store.ts`.

- [Goals](#goals)
- [Why this shape](#why-this-shape)
- [Directory layout](#directory-layout)
- [File formats](#file-formats): [`.dat`](#dat--payloads) · [`.idx`](#idx--the-index) · [payload](#the-payload)
- [Request-body delta](#request-body-delta)
- [What is persisted](#what-is-persisted)
- [Write path and crash safety](#write-path-and-crash-safety)
- [Opening, the index, several processes](#opening-the-index-several-processes)
- [Reads](#reads)
- [Retention](#retention)
- [Clearing](#clearing)
- [Importing earlier versions](#importing-earlier-versions)
- [Memory](#memory)
- [Constants](#constants)
- [Versioning](#versioning)
- [Known limitations](#known-limitations)
- [Inspecting a segment by hand](#inspecting-a-segment-by-hand)

## Goals

1. **Keep far more history across restarts.** Up to 0.5.x a record was one indented JSON file and the cap was 300 files.
2. **Small, and fast to read and write.** Nobody edits these files, and nobody needs to read them outside the Wire Trace tab, so the format is free to be binary and compressed.
3. **Lossless.** Request and response bodies are rebuilt to the exact captured string — curl replay and the merged SSE view depend on it. (Credential headers and URL query credentials are redacted *before* anything is stored; that is a separate, deliberate rule.)
4. **One number to configure.** A disk budget, not a record count.
5. **Never break capture or the viewer.** Every I/O failure is swallowed and counted (`stats().failures`); a failed write leaves the record in memory.
6. **No shared mutable file.** Several DSH processes can use one directory.
7. **No native dependencies, Node >= 22.6.** Only `node:fs`, `node:zlib` and friends.

## Why this shape

Measured on a real trace directory (343 files, 146.8 MB):

| Observation | Number | Consequence |
|---|---|---|
| Records that were bodiless polls (`GET /models`) | 304 of 307 | They filled the 300-record cap and pushed real calls out. They are no longer persisted. |
| Request bodies, general-purpose compression | gzip 1.7×, brotli 1.7–1.8×, zstd 1.7–1.8× | The codec barely matters for requests. |
| Response bodies (SSE), same codecs | 5.1–5.4× | Responses compress well. |
| Share of a request body identical to the previous request of the same session | 97.3–99.7% | **Delta against the previous request is the big win.** |
| Result of the above | 146.8 MB / 343 files → 3.4 MB / 85 records | About 1/43 (the 258 housekeeping files are not carried over, and every body was verified byte-for-byte after the round trip). |

Alternatives that were considered:

| Option | Why not |
|---|---|
| One JSON file per record (≤ 0.5.x) | No index, so every list read opens files; retention by count; no compression; 1.7 MB per record. |
| One compressed JSONL stream | A gzip/brotli stream cannot be read at an offset, and retention means rewriting the file — which races when two processes share it. |
| SQLite (`node:sqlite`) | It was behind a flag until Node 22.13 and this package supports 22.6+; one shared database file means cross-process locking; freeing space needs `VACUUM`; and it would not give the delta encoding for free. |
| **Append-only segments + in-memory index** (chosen) | Random access by offset, retention by deleting whole files, no shared mutable file, and delta encoding fits naturally inside a segment. |

Brotli (quality 5) is used because it is available on every supported Node; `node:zlib`'s zstd arrived in later 22.x releases and is still experimental. Quality 5 was chosen on measurement: on real 1.6–1.8 MB request bodies quality 9 took about 71 ms per record against 13 ms for quality 5, and saved 1.5% more.

## Directory layout

The trace directory is `traceDir` (default `$DSH_HOME/llm-wire-trace/records`, else `~/.dsh/llm-wire-trace/records`). It holds **segments**; a segment is a pair of files sharing a stem:

```
records/
├── 1795260451295-ab5f3a2c.dat     compressed payloads, back to back
├── 1795260451295-ab5f3a2c.idx     one JSON line per record
├── 1795260587625-9095846b.dat
└── 1795260587625-9095846b.idx
```

- **Stem**: `<13-digit start ms>-<8 hex random>` (`SEGMENT_FILE = /^(\d{13})-([0-9a-f]{8})\.(dat|idx)$/`). The start time leads, so sorting stems sorts segments by age; the random tail keeps two processes (or two segments in one millisecond) apart.
- Anything else in the directory is ignored, except the legacy files described [below](#importing-earlier-versions).
- **A segment is written only by the process that created it.** That is the whole concurrency story across processes.
- A segment is closed (and a new one started on the next write) once its `.dat` reaches the target size, `clamp(budget / 16, 1 MB, 64 MB)` — 64 MB at the default budget. It can overshoot by the size of one payload.

**Record id**: `<13-digit ms>-<4 hex intra-ms counter>-<8 hex random>`, e.g. `1795258912236-0000-51e9852c` (`buildRecordId`). Plain string order is chronological order; the counter keeps a burst inside one millisecond in order, the random tail keeps ids unique across processes. The viewer sorts by `(startedAt, id)`.

## File formats

### `.dat` — payloads

A flat concatenation of independent **brotli streams**, one per record, with no header, footer or framing. Where a payload starts and how long it is comes only from the `.idx`. Each is compressed on its own (`BROTLI_PARAM_QUALITY` 5, `BROTLI_PARAM_LGWIN` 24) so any record can be read without touching its neighbours; what is lost is dictionary sharing between records, which the [delta](#request-body-delta) recovers for the one case that matters. The decompressed bytes are UTF-8 JSON (the [payload](#the-payload)).

### `.idx` — the index

JSON Lines, UTF-8, one line per record, each terminated by `\n`, appended in write order. A line carries exactly what a list row displays, plus where the payload is. It never carries a body or headers, so the whole index fits in memory.

```json
{"id":"1795258912236-0000-51e9852c","startedAt":1795258912236,"endedAt":1795258989224,"durationMs":76988,"status":"ok","model":"claude-opus-5.5","sessionId":"session-…","turn":7,"step":1,"purpose":null,"provider":"github-copilot","requestedModel":"claude-opus-5.5","attributed":true,"request":{"method":"POST","url":"https://api.business.githubcopilot.com/v1/messages?beta=true","bodyChars":1633462,"bodyTruncated":false},"response":{"status":200,"statusText":"OK","contentType":"text/event-stream","bodyChars":115186,"bodyTruncated":false},"error":null,"recorderError":null,"o":3004,"n":979259}
```

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Record id. Required, non-empty. |
| `startedAt` / `endedAt` / `durationMs` | number \| null | Epoch ms; `endedAt`/`durationMs` are stamped when the call finishes. |
| `status` | string | `ok`, `http-error`, `transport-error`. Records are written when the call finishes, so `streaming` appears only in the rare case the response could not be cloned (`recorderError` then says so). |
| `model`, `requestedModel`, `provider`, `purpose` | string \| null | Harness coordinates; `purpose` is `session-title`, `compaction`, … for background calls. |
| `sessionId`, `turn`, `step` | string \| number \| null | Session and position; `null` when unattributed. |
| `attributed` | boolean | The call went through `ctx.llm`, so it carries real coordinates. |
| `request` | object | `method`, `url`, `bodyChars` (length before clipping), `bodyTruncated`. |
| `response` | object \| null | `status`, `statusText`, `contentType`, `bodyChars`, `bodyTruncated`. `null` when no response arrived. |
| `error` | `{name,message}` \| null | A transport error. |
| `recorderError` | string \| null | This plugin failed to mirror a body (never a wire-level error). |
| **`o`** | integer ≥ 0 | Byte offset of the payload in the `.dat`. |
| **`n`** | integer > 0 | Compressed payload length in bytes. |
| **`b`** | string | **Present only for a delta**: the id of the record whose request body this one is based on. |

A line is accepted only if it parses, has a non-empty `id` and valid `o`/`n`, **and** `o + n` fits inside the `.dat`. Anything else — a line torn by a crash, a payload that never fully landed — is skipped, never fatal. An average line is about 660 bytes in a real segment.

### The payload

The decompressed JSON of one record (`encodeRecord` / `decodeRecord`). It is **self-contained**: it repeats every field above, so a damaged index line can never make a payload unreadable, and adds the bodies and headers.

```jsonc
{
  "v": 2,                              // payload format version
  "id": "…", "startedAt": 0, "endedAt": 0, "durationMs": 0, "status": "ok",
  "model": "…", "sessionId": "…", "turn": 7, "step": 2, "purpose": null,
  "provider": "…", "requestedModel": "…", "attributed": true,
  "request": {
    "method": "POST",
    "url": "https://…",                // query credentials already redacted
    "headers": { "authorization": "Bearer ***redacted***", "…": "…" },
    "bodyChars": 1861538,              // original length, before clipping
    "bodyTruncated": false,            // true when clipped at 8,000,000 characters
    // exactly one of the next two:
    "bodyText": "{\"model\":…",        // the literal request body
    "delta": { "base": "…", "prefix": 1813498, "suffix": 41742, "middle": "…", "length": 1861538 }
  },
  "response": {                        // null when no response arrived
    "status": 200, "statusText": "OK",
    "headers": { "content-type": "text/event-stream" },
    "contentType": "text/event-stream",
    "bodyText": "event: message_start\ndata: …",   // the literal response body (SSE: all frames)
    "bodyChars": 282575, "bodyTruncated": false
  },
  "error": null,                       // or { "name": "…", "message": "…" }
  "recorderError": null                // or a string
}
```

Notes:

- Only the **request** body can be a delta; a response is always stored whole (it compresses ~5× on its own).
- `bodyJson` — the parsed form — is **never stored**. It is re-derived on read from `bodyText` (and, for an SSE response, deliberately never parsed as one JSON value). `persisted: true` is added on read.
- `bodyText` is the literal text, possibly clipped to 8,000,000 characters; `bodyChars` is the length before clipping and `bodyTruncated` says whether it was. A delta's `length` is the length of the *stored* (clipped) text.
- `v` is written as `2`; `1` was the per-record JSON file of earlier versions.

## Request-body delta

Consecutive requests of one conversation repeat the whole history and add a little at the end; the fields after the message list (`tools`, `stream`, …) stay put. So a request is stored as **the common prefix length, the common suffix length, and the characters in between**, against the previous request of the same conversation.

```
base : [ ──────── prefix ──────── | … changed … | ── suffix ── ]
this : [ ──────── prefix ──────── | middle (new) | ── suffix ── ]
stored: { base: <id>, prefix: P, suffix: S, middle: "<new characters>", length: L }
```

**Which request is the base — the "lane".** A lane is `sessionId · purpose · METHOD url`. Each writer remembers the previous request body of up to 8 lanes (LRU). A record with no session has no lane and is stored whole. Because lanes live in the writer, a base is always in the **same segment** — a fresh segment starts every lane with a full copy.

**When a delta is used** (`planDelta`) — all must hold, otherwise the body is stored whole:

1. the lane has a previous request in this writer;
2. that previous request's chain has fewer than 32 deltas (`MAX_DELTA_CHAIN`);
3. the body has at least 4,096 characters (`MIN_DELTA_CHARS`);
4. `(prefix + suffix) × 2 ≥ length` — it saves at least half.

Prefix and suffix are counted in UTF-16 code units; the suffix is limited to what the prefix left over, so they never overlap. A cut inside a surrogate pair is harmless: the rebuild is a plain string concatenation.

**Rebuild** (`applyDelta`): `base.slice(0, prefix) + middle + base.slice(base.length − suffix)`. It throws if `prefix + suffix` exceeds the base or the result is not `length` characters long, so a wrong or corrupt base can never produce a plausible-looking wrong body.

**Chains.** Reading a delta means reading its base first, recursively. A full copy is therefore forced at least every 33 requests of a lane, which bounds the work of opening any record to at most 33 reads, and a rebuilt body is cached so walking through neighbours does not repeat it. A chain longer than 33 on read is treated as corruption.

**A real example** (a 1.86 M-character request): `prefix` 1,813,498, `suffix` 41,742, `middle` 6,298 characters — 99.7% shared. The whole record, headers and a 282 KB response included, compressed to 56,728 bytes; the response is now most of what is left.

## What is persisted

`shouldPersist(record)` decides, when a call finishes:

- an **attributed** call (made through `ctx.llm`) is always persisted;
- otherwise it is persisted only if its request has a body.

A bodiless request outside any model call is provider housekeeping — the harness polls `GET /models`, for example. Those stay in memory (so they still show live in the tab until restart) and never displace history. Records are written **once, when finished**: an in-flight call lives only in memory, so a crash loses calls that were still running.

## Write path and crash safety

`save()` is never awaited by capture, so a slow disk cannot slow a model call. Inside the archive every mutation goes through **one in-process promise queue** (writes, clears, retention, the import), so they never interleave.

For one record (`write`):

1. Skip if the id is already indexed (writes are idempotent).
2. Get the writer. If its `.dat` no longer exists (another process cleared the directory), forget that segment and open a new one; if it reached the target size, close it and open a new one.
3. Choose full copy or delta (above); `encodeRecord`; brotli-compress.
4. **Append the payload to the `.dat`, then append the index line to the `.idx`.** The order is the crash-safety rule: an index line only ever points at bytes already on disk.
5. Add the record to the in-memory index, update the lane, cache the rebuilt body, then enforce the [budget](#retention).

Crash and failure behaviour:

- A crash between 4's two writes leaves payload bytes no index line points at. They are harmless, and are never read.
- A crash mid-append can leave a torn last `.idx` line; it fails to parse (or its payload does not fit) and is skipped on the next start.
- A failed append closes the writer, so the next record starts a fresh segment instead of appending after an unknown tail, and `save()` resolves `false` — the store then keeps the record in its in-memory ring.
- Nothing is ever rewritten in place, so a crash cannot corrupt a record that was already stored.

## Opening, the index, several processes

`open()` (idempotent; the plugin starts it at activation) does, in this order: create the directory, **scan** it, mark the archive ready, enforce the budget (a lowered `maxDiskMB` takes effect at once), then start the [legacy import](#importing-earlier-versions) in the background.

**Scan** (`scan`): `readdir`; keep only stems that have both a `.dat` and an `.idx`; for each segment this process did not create, `stat` both files — **the `.idx` first, then the `.dat`** — and parse the `.idx` from the point it last read to the last complete line; forget segments whose files have vanished. A segment this process created is already authoritative in memory and is skipped. Because only complete lines are parsed and the read position advances only past them, a segment another process is still appending to can be followed incrementally. The `stat` order matters: a payload is always appended before its index line (see the write path), so a data size measured *after* the index covers every line that index shows. Measured the other way round, a record appended in between would produce an index line whose payload lies beyond the measured data size; that line would be skipped and the read position moved past it, so the record would never appear until the next start. A test pins the order by writing a record between the two measurements.

The scan runs at open, then at most every 5 s (`RESCAN_INTERVAL_MS`) when a list is requested, and whenever `get` is asked for an id the index does not know. So another process's records appear within a few seconds, and are readable at once if asked for by id.

Index loading yields to the event loop between segments, because parsing is synchronous and the web UI shares the loop. On a real directory the index loads in about 1 ms.

## Reads

**List** (`list`) answers from memory only — no file is touched. The index is an array of entries ordered oldest-first by `(startedAt, id)` plus a per-session count, so a page of the newest records, the `matched` count of a session filter and the `total` are all cheap. The session filter is applied before the page window, so a busy neighbouring session cannot push a quiet one out of its page.

**Get** (`get`): look up the entry, `pread` `n` bytes at `o` from the `.dat`, brotli-decompress, parse; if the request is a delta, rebuild it from its base (recursively, through a small cache), then attach `bodyJson` and mark `persisted: true`. One positioned read and one decompression for a full record; on real data the slowest `get` was about 26 ms. A missing file (`ENOENT`) returns `null`; any other failure is counted.

`store.ts` sits on top: a finished record is handed to the archive once and **leaves the in-memory ring as soon as the archive has it**. `listAll` merges the ring with the archive's index (the live copy wins for a shared id) and adds records only memory holds to the counts. While the index is still loading, the viewer's fast path answers from memory alone and says history is pending.

## Retention

The budget is `maxDiskMB` (default 1024, minimum 16) over **all segments' `.dat` and `.idx` files** in the directory, including ones other processes wrote. After every write, and at open, if the total exceeds it:

1. take every segment except the one being written;
2. order them by the `startedAt` of the **newest record they contain**, oldest first;
3. delete whole segments (forget their index entries, delete both files) until the total fits.

Deleting whole files is O(1) and returns the space immediately — there is nothing to compact or vacuum. It is safe because [deltas never cross a segment](#request-body-delta): no surviving record can lose its base. The price is granularity: the disk can exceed the budget by about one active segment (up to 64 MB at the default), and old history disappears a segment at a time.

## Clearing

- **Clear all** (the panel's button): close this process's writer, delete every segment file found in the directory, empty the index and caches.
- **Clear one session** (the tab's button): for each segment that holds that session, delete it outright if nothing else is in it; otherwise **rewrite** it — write a new segment (same start time, new random tail) containing only the other records' *compressed payloads copied as they are*, with their index lines (including `b`), then delete the old one. Nothing is decompressed or recompressed. Deltas only chain inside one session, so no kept record loses its base.
- A clear waits for the legacy import to finish first, or the import would bring back what was just cleared.
- Other processes notice on their next scan. A writer whose segment was deleted notices at its next write (it checks that its `.dat` still exists) and starts a new segment.

## Importing earlier versions

Versions up to 0.5.x wrote one file per record, `<id>.json`, matching `/^(\d{13,})-(?:[0-9a-f]{4}-)?[0-9a-f]{6,}\.json$/` — one indented JSON document (`"v": 1`) with `request`/`response` objects holding `headers`, `bodyText`, `bodyChars`, `bodyTruncated` and a `bodyJson` readability copy.

At open, a background task imports them, **oldest first, through the normal write path** (so deltas and the budget apply; `stats().legacyPending` counts what is left, and the panel shows it):

- the `bodyJson` copy is dropped — `bodyText` was always the authoritative form;
- a file is deleted once its record is stored — or when it needs no storing: housekeeping per `shouldPersist`, a JSON document that is not a record, or an **echo**;
- a file that fails to parse is **left in place** and counted as a failure — unreadable data is never destroyed;
- a failed write leaves the file, so the next start tries again; closing the archive stops the import, which resumes next time.
- Stale `*.json.<hex>.tmp` files from the old atomic write are deleted.

**Echoes.** Updating the plugin in place can leave the *old* version's `fetch` wrapper inside the fetch chain, where it keeps writing old-format files for every call until DSH restarts. Such a file is recognized — unattributed, and the same URL and body size as an attributed record started within one second — and discarded instead of imported as a duplicate. (From 0.6.0 on, disposing the patch also disarms its wrapper, so this stops happening.)

## Memory

| What | Bounded by |
|---|---|
| The index: one entry per stored record (list fields, segment, offset, length, base), a per-session count, and the segment table | the number of stored records; a record's index line averages ~660 bytes on disk |
| The in-memory ring (`MEMORY_RING_SIZE`) | 100 records: in-flight calls, records the archive declined (housekeeping, failed writes), and — with `persist: false` — the whole history |
| Delta lanes (previous request body per conversation) | 8 per writer |
| Rebuilt request bodies (`BODY_CACHE_ENTRIES`) | 6 |

Each retained request body can be up to 8,000,000 characters (about 2 MB in practice), so the lanes and cache are the part to remember when sizing.

## Constants

| Constant | Value | Where |
|---|---|---|
| `DEFAULT_MAX_DISK_MB` / `MIN_MAX_DISK_MB` | 1024 / 16 | `persistence/constants.ts` |
| `MIN_SEGMENT_BYTES` / `MAX_SEGMENT_BYTES` / `SEGMENTS_PER_BUDGET` | 1 MB / 64 MB / 16 | same |
| `MAX_DELTA_CHAIN` | 32 | same |
| `MIN_DELTA_CHARS` | 4,096 | same |
| `MAX_DELTA_LANES` | 8 | same |
| `BODY_CACHE_ENTRIES` | 6 | same |
| `BROTLI_QUALITY` / `BROTLI_WINDOW_BITS` | 5 / 24 | same |
| `RESCAN_INTERVAL_MS` | 5,000 | same |
| `PAYLOAD_VERSION` | 2 | `persistence/codec.ts` |
| `MEMORY_RING_SIZE` | 100 | `host/constants.ts` |
| Body capture cap (`DEFAULT_MAX_BODY_CHARS`) | 8,000,000 characters | `host/constants.ts`; fixed, not configurable |

Only `persist`, `maxDiskMB` and `traceDir` are user settings; everything above is deliberately not.

## Versioning

The payload carries `v: 2`, but **nothing reads it yet**: `decodeRecord` accepts any object with the expected shape and extra fields pass through. A future format change must add the branch on `v` in `decodeRecord` first, and either keep reading `2` or import it like version 1. The index has no version field; adding a field is backward compatible (unknown fields are ignored by `parseIndexLine`), while changing the meaning of `o`, `n` or `b` is not. Segment names are the discriminator for the directory: files that do not match `SEGMENT_FILE` are never touched, so a new layout can live beside this one.

## Known limitations

- **Delta chains restart with each process and each segment.** The first request of every conversation after a restart (or segment rollover) is a full copy — 6 of 96 records in one real segment.
- **The budget is soft by one segment**, and retention is whole segments, oldest content first.
- **A trailing orphan payload from a crash is never reclaimed** until its segment is deleted by retention or rewritten by a session clear (which copies only indexed records).
- **A crash in the middle of a session-scoped clear** can leave both the old segment and its rewritten copy. The old one still holds the cleared session until retention removes it.
- **A session-scoped clear costs a rewrite** of every segment that holds the session — up to 64 MB each.
- **The whole index is in memory**, so memory grows with the number of stored records (bounded in practice by the disk budget).
- **Records still running when the process dies are lost** — they are written only when finished.
- If a delta's base is ever missing (manual tampering or corruption), `get` for that record returns `null` and counts a failure.

## Inspecting a segment by hand

The files are not meant to be opened with an editor, but they are plain: this script (Node >= 22) lists a segment, or rebuilds one record's full request body.

```js
// inspect.mjs
//   node inspect.mjs <dir>/<stem>          list the segment's records
//   node inspect.mjs <dir>/<stem> <id>     print that record's full request body
import { readFileSync } from 'node:fs'
import { brotliDecompressSync } from 'node:zlib'

const [stem, wanted] = process.argv.slice(2)
const dat = readFileSync(`${stem}.dat`)
const index = new Map(readFileSync(`${stem}.idx`, 'utf8').split('\n').filter(Boolean).map((line) => {
  const entry = JSON.parse(line)
  return [entry.id, entry]
}))
const payload = (id) => {
  const e = index.get(id)
  return JSON.parse(brotliDecompressSync(dat.subarray(e.o, e.o + e.n)).toString('utf8'))
}
const body = (id) => {
  const { request } = payload(id)
  if (!request.delta) return request.bodyText
  const base = body(request.delta.base)
  return base.slice(0, request.delta.prefix) + request.delta.middle + base.slice(base.length - request.delta.suffix)
}

if (wanted) process.stdout.write(body(wanted))
else for (const [id, e] of index) console.log(id, e.b ? `delta<-${e.b}` : 'full', `${e.n} B`, e.sessionId ?? '-', `T${e.turn ?? '-'}S${e.step ?? '-'}`)
```

Run it against a directory in use only to read; it opens nothing for writing. (A segment that another process is appending to may end in a torn `.idx` line — drop a final line that does not parse.)

## Tests

`test/host/persistence/` pins this document: `codec.test.ts` (persist policy, delta round trips including a cut inside a surrogate pair, payload and index-line round trips, torn lines, legacy conversion), `naming.test.ts` (ids and stems) and `archive.test.ts` (round trip, compression, delta chains and the 32-link cap, retention by budget, both kinds of clear, torn index lines, the legacy import and its echo rule, two processes on one directory). After changing the format, also round-trip a copy of a real trace directory through the compiled `dist/host/persistence/archive.js` — `AGENTS.md` requires it, because synthetic fixtures are smaller and tidier than real traffic.
