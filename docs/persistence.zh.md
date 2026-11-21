# 持久化：设计与数据格式

[English](persistence.md) | 中文

自 0.6.0 起 Wire Trace 记录在磁盘上的存储方式：目录布局、每种文件的字节级格式、背后的算法以及已知限制。用户层面能看到的内容（位置、容量上限、清除），请看主 README 的[持久化](../README.zh.md#持久化)；模块之间如何配合，见 [`architecture.zh.md`](architecture.zh.md)。代码位于 `src/host/persistence/`——`naming.ts`（命名，无 I/O）、`codec.ts`（存什么，无 I/O）、`archive.ts`（全部 I/O）和 `constants.ts`——以及内存一侧的 `src/host/store.ts`。

- [目标](#目标)
- [为什么是这个形状](#为什么是这个形状)
- [目录布局](#目录布局)
- [文件格式](#文件格式)：[`.dat`](#dat--payload-数据) · [`.idx`](#idx--索引) · [payload](#payload)
- [请求体增量](#请求体增量)
- [保存哪些记录](#保存哪些记录)
- [写入路径与崩溃安全](#写入路径与崩溃安全)
- [打开、索引与多进程](#打开索引与多进程)
- [读取](#读取)
- [保留策略](#保留策略)
- [清除](#清除)
- [导入旧版本](#导入旧版本)
- [内存](#内存)
- [常量](#常量)
- [版本演进](#版本演进)
- [已知限制](#已知限制)
- [手工查看一个段文件](#手工查看一个段文件)

## 目标

1. **重启后保留多得多的历史。** 0.5.x 及以前，一条记录是一个带缩进的 JSON 文件，上限 300 个文件。
2. **体积小，读写快。** 没有人会去编辑这些文件，也不需要在 Wire Trace 标签页之外阅读它们，所以格式可以是二进制、压缩的。
3. **无损。** 请求体和响应体都能还原成抓到时完全相同的字符串——curl 重放和合并后的 SSE 视图都依赖这一点。（凭据请求头和 URL 查询参数里的凭据，在存储*之前*就已经脱敏；那是另一条独立的、有意为之的规则。）
4. **只有一个要配置的数字。** 是磁盘预算，而不是记录条数。
5. **绝不能拖垮抓包或查看器。** 所有 I/O 失败都被吞掉并计数（`stats().failures`）；写入失败时，记录会留在内存里。
6. **没有共享的可变文件。** 多个 DSH 进程可以共用同一个目录。
7. **没有原生依赖，Node >= 22.6。** 只用 `node:fs`、`node:zlib` 等。

## 为什么是这个形状

在一份真实的 trace 目录上测量（343 个文件，146.8 MB）：

| 观察 | 数字 | 结论 |
|---|---|---|
| 属于无请求体轮询（`GET /models`）的记录 | 307 条里有 304 条 | 它们占满了 300 条上限，把真正的调用挤了出去。现在不再持久化。 |
| 请求体，通用压缩算法 | gzip 1.7×，brotli 1.7–1.8×，zstd 1.7–1.8× | 对请求体来说，换哪种算法几乎没有差别。 |
| 响应体（SSE），同样的算法 | 5.1–5.4× | 响应本身压缩效果很好。 |
| 一个请求体与同一 session 上一次请求相同的比例 | 97.3–99.7% | **相对上一次请求做增量，才是最大的收益。** |
| 以上叠加的结果 | 146.8 MB / 343 个文件 → 3.4 MB / 85 条记录 | 约 1/43。 |

考虑过的其他方案：

| 方案 | 没有采用的原因 |
|---|---|
| 一条记录一个 JSON 文件（≤ 0.5.x） | 没有索引，每次读列表都要打开文件；按条数保留；不压缩；每条 1.7 MB。 |
| 单个压缩的 JSONL 流 | gzip/brotli 流无法从某个偏移量开始读；保留策略意味着重写整个文件，而两个进程共用时会产生竞争。 |
| SQLite（`node:sqlite`） | Node 22.13 之前它还在实验开关后面，而本包支持 22.6+；一个共享的数据库文件意味着跨进程加锁；释放空间需要 `VACUUM`；而且它并不会免费带来增量编码。 |
| **只追加的段文件 + 内存索引**（采用） | 可按偏移随机访问，保留策略就是删除整个文件，没有共享的可变文件，增量编码天然适合放在一个段内。 |

选用 brotli（质量 5），是因为它在所有受支持的 Node 版本上都可用；`node:zlib` 的 zstd 在更晚的 22.x 版本才出现，而且仍是实验性的。质量 5 是按实测选的：在真实的 1.6–1.8 MB 请求体上，质量 9 每条约 71 ms，质量 5 约 13 ms，前者只多省 1.5%。

## 目录布局

trace 目录是 `traceDir`（默认 `$DSH_HOME/llm-wire-trace/records`，否则 `~/.dsh/llm-wire-trace/records`）。里面放的是**段（segment）**；一个段是共用同一个词干的一对文件：

```
records/
├── 1795260451295-ab5f3a2c.dat     压缩后的 payload，首尾相接
├── 1795260451295-ab5f3a2c.idx     每条记录一行 JSON
├── 1795260587625-9095846b.dat
└── 1795260587625-9095846b.idx
```

- **词干**：`<13 位起始毫秒>-<8 位十六进制随机数>`（`SEGMENT_FILE = /^(\d{13})-([0-9a-f]{8})\.(dat|idx)$/`）。起始时间放在最前，所以按词干排序就是按段的新旧排序；随机尾巴把两个进程（或同一毫秒内的两个段）区分开。
- 目录里的其他文件一律忽略，唯一的例外是[下文](#导入旧版本)描述的旧版文件。
- **一个段只由创建它的进程写入。** 跨进程的并发问题就是靠这一条解决的。
- 一个段的 `.dat` 达到目标大小后就会关闭，下一次写入时另起新段。目标大小是 `clamp(预算 / 16, 1 MB, 64 MB)`——默认预算下是 64 MB。一个段最多会超出目标大小一个 payload 的体积。

**记录 id**：`<13 位毫秒>-<4 位十六进制毫秒内序号>-<8 位十六进制随机数>`，例如 `1795258912236-0000-51e9852c`（`buildRecordId`）。直接按字符串排序就是按时间排序；序号让同一毫秒内的一批调用保持先后顺序，随机尾巴让 id 在多个进程间保持唯一。查看器按 `(startedAt, id)` 排序。

## 文件格式

### `.dat` — payload 数据

一串相互独立的 **brotli 流**首尾相接，每条记录一个，没有头、尾，也没有分帧。某个 payload 从哪里开始、有多长，只能从 `.idx` 得知。每个 payload 单独压缩（`BROTLI_PARAM_QUALITY` 5，`BROTLI_PARAM_LGWIN` 24），所以读任何一条记录都不用碰它的邻居；代价是记录之间无法共享字典，而这一点由[增量](#请求体增量)在最关键的场景里补了回来。解压后的字节是 UTF-8 的 JSON（即 [payload](#payload)）。

### `.idx` — 索引

JSON Lines，UTF-8，每条记录一行，以 `\n` 结尾，按写入顺序追加。一行恰好包含列表行要显示的内容，再加上 payload 的位置。它从不包含请求体或请求头，所以整份索引都能放进内存。

```json
{"id":"1795258912236-0000-51e9852c","startedAt":1795258912236,"endedAt":1795258989224,"durationMs":76988,"status":"ok","model":"claude-opus-5.5","sessionId":"session-…","turn":7,"step":1,"purpose":null,"provider":"github-copilot","requestedModel":"claude-opus-5.5","attributed":true,"request":{"method":"POST","url":"https://api.business.githubcopilot.com/v1/messages?beta=true","bodyChars":1633462,"bodyTruncated":false},"response":{"status":200,"statusText":"OK","contentType":"text/event-stream","bodyChars":115186,"bodyTruncated":false},"error":null,"recorderError":null,"o":3004,"n":979259}
```

| 字段 | 类型 | 含义 |
|---|---|---|
| `id` | string | 记录 id。必填，非空。 |
| `startedAt` / `endedAt` / `durationMs` | number \| null | 毫秒时间戳；`endedAt`/`durationMs` 在调用结束时写入。 |
| `status` | string | `ok`、`http-error`、`transport-error`。记录在调用结束时才写入，所以只有在响应无法克隆这种罕见情况下才会出现 `streaming`（此时 `recorderError` 会说明）。 |
| `model`、`requestedModel`、`provider`、`purpose` | string \| null | harness 坐标；`purpose` 对后台调用是 `session-title`、`compaction` 等。 |
| `sessionId`、`turn`、`step` | string \| number \| null | session 及所处位置；无归属时为 `null`。 |
| `attributed` | boolean | 这次调用经过了 `ctx.llm`，因此带有真实的坐标。 |
| `request` | object | `method`、`url`、`bodyChars`（截断前的长度）、`bodyTruncated`。 |
| `response` | object \| null | `status`、`statusText`、`contentType`、`bodyChars`、`bodyTruncated`。没收到响应时为 `null`。 |
| `error` | `{name,message}` \| null | 传输层错误。 |
| `recorderError` | string \| null | 本插件没能镜像下某个 body（绝不是线路层面的错误）。 |
| **`o`** | integer ≥ 0 | payload 在 `.dat` 中的字节偏移。 |
| **`n`** | integer > 0 | 压缩后 payload 的字节长度。 |
| **`b`** | string | **只有增量记录才有**：这条记录的请求体所基于的那条记录的 id。 |

一行只有同时满足这些条件才会被接受：能解析、`id` 非空、`o`/`n` 合法，**并且** `o + n` 落在 `.dat` 的范围内。其余情况——崩溃时被撕断的一行、没有完整写入的 payload——都会被跳过，从不致命。真实段里一行平均约 660 字节。

### payload

一条记录解压后的 JSON（`encodeRecord` / `decodeRecord`）。它是**自包含**的：重复了上面的全部字段，所以一行受损的索引永远不会让 payload 无法读取；此外还加上了 body 和请求头。

```jsonc
{
  "v": 2,                              // payload 格式版本
  "id": "…", "startedAt": 0, "endedAt": 0, "durationMs": 0, "status": "ok",
  "model": "…", "sessionId": "…", "turn": 7, "step": 2, "purpose": null,
  "provider": "…", "requestedModel": "…", "attributed": true,
  "request": {
    "method": "POST",
    "url": "https://…",                // 查询参数里的凭据已脱敏
    "headers": { "authorization": "Bearer ***redacted***", "…": "…" },
    "bodyChars": 1861538,              // 原始长度，截断之前
    "bodyTruncated": false,            // 超过 8,000,000 个字符被截断时为 true
    // 下面两项恰好出现一项：
    "bodyText": "{\"model\":…",        // 请求体原文
    "delta": { "base": "…", "prefix": 1813498, "suffix": 41742, "middle": "…", "length": 1861538 }
  },
  "response": {                        // 没收到响应时为 null
    "status": 200, "statusText": "OK",
    "headers": { "content-type": "text/event-stream" },
    "contentType": "text/event-stream",
    "bodyText": "event: message_start\ndata: …",   // 响应体原文（SSE：全部帧）
    "bodyChars": 282575, "bodyTruncated": false
  },
  "error": null,                       // 或 { "name": "…", "message": "…" }
  "recorderError": null                // 或一个字符串
}
```

说明：

- 只有**请求体**可以是增量；响应体永远整体存储（它自己就能压缩到约 1/5）。
- `bodyJson`——解析后的形式——**从不存储**。读取时由 `bodyText` 重新推导（SSE 响应则有意从不当作一个 JSON 整体去解析）。读取时会加上 `persisted: true`。
- `bodyText` 是原文，最多截断到 8,000,000 个字符；`bodyChars` 是截断前的长度，`bodyTruncated` 说明有没有被截断。增量的 `length` 是*已存储*（截断后）文本的长度。
- `v` 写成 `2`；`1` 是旧版本里一条记录一个 JSON 文件的格式。

## 请求体增量

同一段对话里连续的请求，会重复整段历史，只在末尾加一点；消息列表之后的字段（`tools`、`stream` 等）保持不变。所以一个请求相对同一段对话的上一次请求，只存**公共前缀的长度、公共后缀的长度，以及两者之间的字符**。

```
base : [ ──────── prefix ──────── | … 有变化 … | ── suffix ── ]
this : [ ──────── prefix ──────── | middle（新）| ── suffix ── ]
存储 : { base: <id>, prefix: P, suffix: S, middle: "<新增的字符>", length: L }
```

**谁是 base——"车道"（lane）。** 一条车道是 `sessionId · purpose · METHOD url`。每个写入器会记住最多 8 条车道各自的上一次请求体（LRU）。没有 session 的记录没有车道，整体存储。因为车道存在写入器里，base 永远在**同一个段**内——一个新段会让每条车道都从完整副本重新开始。

**什么时候用增量**（`planDelta`）——下面四条必须同时成立，否则整体存储：

1. 这条车道在当前写入器里有上一次请求；
2. 上一次请求所在的链上增量数少于 32 个（`MAX_DELTA_CHAIN`）；
3. 请求体至少有 4,096 个字符（`MIN_DELTA_CHARS`）；
4. `(prefix + suffix) × 2 ≥ length`——至少能省掉一半。

前缀和后缀都按 UTF-16 码元计数；后缀只能取前缀剩下的部分，所以两者不会重叠。切在代理对中间也没有问题：还原只是普通的字符串拼接。

**还原**（`applyDelta`）：`base.slice(0, prefix) + middle + base.slice(base.length − suffix)`。如果 `prefix + suffix` 超过了 base 的长度，或者结果的长度不等于 `length`，就会抛错，所以一个错误或损坏的 base 绝不可能产出一个看起来合理、实则错误的请求体。

**链。** 读取增量需要先读它的 base，递归进行。所以同一条车道上至少每 33 个请求就会强制写一份完整副本，打开任何一条记录最多只需要读 33 次；还原出的请求体会被缓存，因此顺着相邻记录翻看不会重复计算。读取时如果发现链长超过 33，就当作数据损坏处理。

**一个真实的例子**（一个 186 万字符的请求）：`prefix` 1,813,498，`suffix` 41,742，`middle` 6,298 个字符——99.7% 是共享的。整条记录（含请求头和 282 KB 的响应）压缩后是 56,728 字节；现在占大头的是响应。

## 保存哪些记录

调用结束时由 `shouldPersist(record)` 决定：

- **有归属**的调用（经过 `ctx.llm` 发出）一律保存；
- 否则，只有请求带有请求体才保存。

在任何模型调用之外、又没有请求体的请求属于提供方的杂务——例如 harness 会轮询 `GET /models`。它们只留在内存里（所以在重启前仍会实时显示在标签页上），而且绝不会挤掉历史。记录**只在结束时写一次**：进行中的调用只存在于内存，所以进程崩溃会丢掉仍在运行的调用。

## 写入路径与崩溃安全

抓包路径从不等待 `save()`，所以磁盘慢不会拖慢模型调用。在 archive 内部，所有修改（写入、清除、保留、导入）都通过**同一个进程内的 promise 队列**，不会交错执行。

一条记录的写入（`write`）：

1. 如果这个 id 已经在索引里就跳过（写入是幂等的）。
2. 取得写入器。如果它的 `.dat` 已经不存在了（别的进程清空了目录），就忘掉这个段并另开一个新段；如果它已经达到目标大小，就关闭并另开新段。
3. 选择整体存储还是增量（见上文）；`encodeRecord`；brotli 压缩。
4. **先把 payload 追加到 `.dat`，再把索引行追加到 `.idx`。** 这个顺序就是崩溃安全的规则：索引行指向的字节，一定已经在磁盘上了。
5. 把记录加入内存索引，更新车道，缓存还原出的请求体，然后执行[预算](#保留策略)检查。

崩溃与失败时的行为：

- 在第 4 步两次写入之间崩溃，会留下没有任何索引行指向的 payload 字节。它们无害，也永远不会被读到。
- 追加到一半崩溃，可能留下被撕断的最后一行 `.idx`；下次启动时它解析失败（或者它的 payload 放不进 `.dat`），被跳过。
- 追加失败会关闭写入器，于是下一条记录会另开新段，而不是接在一个未知的末尾后面；同时 `save()` 返回 `false`——store 随即把这条记录留在内存环里。
- 任何内容都不会被原地改写，所以崩溃不可能损坏一条已经存好的记录。

## 打开、索引与多进程

`open()`（幂等；插件在激活时就启动它）按这个顺序做：创建目录、**扫描**目录、标记 archive 就绪、执行预算检查（调低 `maxDiskMB` 会立即生效），然后在后台启动[旧版导入](#导入旧版本)。

**扫描**（`scan`）：`readdir`；只保留同时有 `.dat` 和 `.idx` 的词干；对每个不是本进程创建的段，`stat` 两个文件——**先 `.idx`，再 `.dat`**——并从上次读到的位置开始解析 `.idx`，直到最后一个完整的行；忘掉文件已经消失的段。本进程自己创建的段，在内存里已经是权威的，会被跳过。因为只解析完整的行、读取位置也只前进到完整行的末尾，所以另一个进程仍在追加的段可以被增量地跟随。`stat` 的顺序很重要：payload 总是先于它的索引行被追加（见写入路径），所以在索引*之后*测得的数据大小，一定覆盖那份索引里出现的每一行。如果顺序反过来，两次测量之间被追加的记录会产生一条索引行，它的 payload 落在测得的数据大小之外；这一行会被跳过、读取位置也被推过它，于是这条记录要等到下次启动才会出现。有一个测试通过在两次测量之间写入一条记录来固定这个顺序。

扫描在打开时运行一次，之后在请求列表时至少间隔 5 秒（`RESCAN_INTERVAL_MS`）再运行，另外每当 `get` 被问到一个索引里没有的 id 时也会运行。因此别的进程的记录会在几秒内出现，如果直接按 id 查询则立刻可读。

加载索引时会在段与段之间让出事件循环，因为解析是同步的，而 web UI 共用这个事件循环。在真实目录上，索引加载约 1 ms。

## 读取

**列表**（`list`）只靠内存回答——不碰任何文件。索引是一个按 `(startedAt, id)` 从旧到新排序的数组，外加每个 session 的计数，所以取最新一页记录、session 过滤后的 `matched` 数以及 `total` 都很便宜。session 过滤发生在分页窗口之前，因此繁忙的相邻 session 不会把安静的 session 挤出它自己的那一页。

**读取一条**（`get`）：查到索引条目，在 `.dat` 的偏移 `o` 处 `pread` `n` 字节，brotli 解压，解析；如果请求体是增量，就从它的 base 还原（递归，经过一个小缓存），然后补上 `bodyJson` 并标记 `persisted: true`。完整记录是一次定位读取加一次解压；在真实数据上最慢的一次 `get` 约 26 ms。文件缺失（`ENOENT`）返回 `null`；其他失败会被计数。

`store.ts` 建立在其上：一条结束的记录只交给 archive 一次，**archive 一收下，它就离开内存环**。`listAll` 把内存环与 archive 的索引合并（同一个 id 以实时副本为准），并把只存在于内存的记录加进计数。索引还在加载时，查看器的快速路径只用内存回答，并说明历史尚未就绪。

## 保留策略

预算是 `maxDiskMB`（默认 1024，最小 16），统计目录里**所有段的 `.dat` 与 `.idx` 文件**，包括其他进程写的。每次写入之后，以及打开时，如果总量超出：

1. 取除了正在写入的那个之外的所有段；
2. 按各段**所含最新记录的 `startedAt`** 从旧到新排序；
3. 整段整段地删除（忘掉它们的索引条目，删除两个文件），直到总量满足预算。

删除整个文件是 O(1)，空间立即归还——没有什么需要压缩整理或 vacuum。这样做是安全的，因为[增量从不跨段](#请求体增量)：任何留下来的记录都不会失去它的 base。代价是粒度：磁盘占用最多可能超出预算约一个活跃段（默认预算下最多 64 MB），而且旧历史是一段一段消失的。

## 清除

- **清除全部**（面板上的按钮）：关闭本进程的写入器，删除目录里找到的所有段文件，清空索引和缓存。
- **清除一个 session**（标签页上的按钮）：对每个包含该 session 的段，如果里面没有别的记录就直接删除；否则就**重写**——写一个新段（起始时间相同，随机尾巴不同），只包含其他记录的*压缩 payload，原样拷贝*，连同它们的索引行（包括 `b`），然后删除旧段。整个过程没有任何解压或重新压缩。增量只会在同一个 session 内成链，所以保留下来的记录不会失去它的 base。
- 清除会先等旧版导入结束，否则导入会把刚清掉的内容又带回来。
- 其他进程在下一次扫描时察觉。段被删除的写入器，会在它下一次写入时察觉（它会检查自己的 `.dat` 是否还在）并另开新段。

## 导入旧版本

0.5.x 及以前的版本每条记录写一个文件 `<id>.json`，匹配 `/^(\d{13,})-(?:[0-9a-f]{4}-)?[0-9a-f]{6,}\.json$/`——一个带缩进的 JSON 文档（`"v": 1`），其中 `request`/`response` 对象包含 `headers`、`bodyText`、`bodyChars`、`bodyTruncated` 以及一份便于阅读的 `bodyJson` 副本。

打开时，由一个后台任务把它们导入，**从旧到新，走正常的写入路径**（所以增量和预算都适用；`stats().legacyPending` 统计剩余的数量，面板也会显示）：

- 丢弃 `bodyJson` 副本——`bodyText` 始终才是权威形式；
- 记录存好之后文件才会被删除——或者它根本不需要存储时：按 `shouldPersist` 属于杂务的、不是一条记录的 JSON 文档，或者是**回声**；
- 解析失败的文件**原样保留**并计为一次失败——读不出来的数据绝不会被销毁；
- 写入失败时文件保留，下次启动重试；关闭 archive 会停止导入，下次接着来。
- 旧版原子写入遗留的 `*.json.<hex>.tmp` 文件会被删除。

**回声。** 原地更新插件，可能让*旧版本*的 `fetch` 包装函数留在 fetch 调用链里，在 DSH 重启之前，它会继续为每次调用写旧格式的文件。这样的文件可以被识别出来——无归属，并且 URL 和请求体大小与一条一秒内开始的有归属记录相同——于是被丢弃，而不是当作重复记录导入。（从 0.6.0 起，销毁补丁时还会让它的包装函数失效，这种情况不会再出现。）

## 内存

| 内容 | 受什么限制 |
|---|---|
| 索引：每条已存记录一个条目（列表字段、段、偏移、长度、base）、每个 session 的计数，以及段表 | 已存记录的数量；一条记录的索引行在磁盘上平均约 660 字节 |
| 内存环（`MEMORY_RING_SIZE`） | 100 条：进行中的调用、archive 没有收下的记录（杂务、写入失败），以及在 `persist: false` 时的全部历史 |
| 增量车道（每段对话的上一次请求体） | 每个写入器 8 条 |
| 还原出的请求体缓存（`BODY_CACHE_ENTRIES`） | 6 条 |

每个被保留的请求体最多可达 8,000,000 个字符（实际约 2 MB），所以评估内存时要记得车道和缓存这一部分。

## 常量

| 常量 | 值 | 位置 |
|---|---|---|
| `DEFAULT_MAX_DISK_MB` / `MIN_MAX_DISK_MB` | 1024 / 16 | `persistence/constants.ts` |
| `MIN_SEGMENT_BYTES` / `MAX_SEGMENT_BYTES` / `SEGMENTS_PER_BUDGET` | 1 MB / 64 MB / 16 | 同上 |
| `MAX_DELTA_CHAIN` | 32 | 同上 |
| `MIN_DELTA_CHARS` | 4,096 | 同上 |
| `MAX_DELTA_LANES` | 8 | 同上 |
| `BODY_CACHE_ENTRIES` | 6 | 同上 |
| `BROTLI_QUALITY` / `BROTLI_WINDOW_BITS` | 5 / 24 | 同上 |
| `RESCAN_INTERVAL_MS` | 5,000 | 同上 |
| `PAYLOAD_VERSION` | 2 | `persistence/codec.ts` |
| `MEMORY_RING_SIZE` | 100 | `host/constants.ts` |
| body 捕获上限（`DEFAULT_MAX_BODY_CHARS`） | 8,000,000 个字符 | `host/constants.ts`；固定，不可配置 |

只有 `persist`、`maxDiskMB` 和 `traceDir` 是用户设置；上面其余的都有意不开放。

## 版本演进

payload 带有 `v: 2`，但**目前没有任何代码读取它**：`decodeRecord` 接受任何形状符合预期的对象，多出来的字段会原样透传。将来改格式时，必须先在 `decodeRecord` 里加上对 `v` 的分支，并且要么继续读 `2`，要么像对待版本 1 那样把它导入。索引没有版本字段；增加字段是向后兼容的（`parseIndexLine` 会忽略未知字段），而改变 `o`、`n` 或 `b` 的含义则不兼容。目录靠段文件名来区分：不匹配 `SEGMENT_FILE` 的文件从不会被碰，所以一种新的布局可以和现在这种并存。

## 已知限制

- **增量链随每个进程、每个段重新开始。** 重启（或换段）之后，每段对话的第一个请求是完整副本——在一个真实段里，96 条记录中有 6 条。
- **预算在一个段的范围内是软的**，而且保留策略是整段删除，最旧的内容优先。
- **崩溃留下的尾部孤立 payload 不会被回收**，直到它所在的段被保留策略删除，或被清除 session 时的重写替换（重写只拷贝有索引的记录）。
- **在清除某个 session 的过程中崩溃**，可能同时留下旧段和重写后的副本。旧段仍然包含被清除的 session，直到保留策略把它删掉。
- **清除某个 session 要付出重写的代价**：包含该 session 的每个段都要重写，每个最多 64 MB。
- **整份索引都在内存里**，所以内存随已存记录数增长（实际上受磁盘预算约束）。
- **进程死亡时仍在运行的记录会丢失**——它们只在结束时才写入。
- 如果某个增量的 base 缺失（人为改动或损坏），对该记录的 `get` 会返回 `null` 并计一次失败。

## 手工查看一个段文件

这些文件不是给人用编辑器打开的，但格式很朴素：下面这个脚本（Node >= 22）可以列出一个段，或者还原某条记录的完整请求体。

```js
// inspect.mjs
//   node inspect.mjs <目录>/<词干>          列出这个段里的记录
//   node inspect.mjs <目录>/<词干> <id>     打印这条记录的完整请求体
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

对正在使用的目录运行它只会读取，不会以写模式打开任何文件。（另一个进程正在追加的段，`.idx` 末尾可能有一行被撕断——丢掉解析失败的最后一行即可。）

## 测试

`test/host/persistence/` 把本文档里的内容固定了下来：`codec.test.ts`（保存策略、增量的往返——包括切在代理对中间的情况、payload 与索引行的往返、被撕断的行、旧版转换）、`naming.test.ts`（id 与词干）和 `archive.test.ts`（往返、压缩、增量链及其 32 环上限、按预算保留、两种清除、被撕断的索引行、旧版导入及其回声规则、两个进程共用一个目录）。改动格式之后，还要把一份真实 trace 目录的副本，经由编译后的 `dist/host/persistence/archive.js` 做一次往返——`AGENTS.md` 对此有要求，因为合成的测试数据比真实流量更小、更整齐。
