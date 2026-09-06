# dsh-llm-trace-plugin

[English](README.md) | 中文

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件，用于捕获每一次 LLM 提供方调用的**原始 HTTP 请求与响应** —— 线路上真实的字节、提供方原生的字段名、未经处理的 SSE 帧 —— 并在 **Wire Trace** 会话标签页中浏览它们。

本插件工作在 *wire（线路）* 层。harness 层的追踪器观察的是 harness 构建出来的、已归一化的 `GenerateOptions` / `StreamChunk` 对象：与提供方无关，且带有 `sessionId` / `turn` / `step` 信息。而本插件完全没有 harness 层的概念 —— 它只看到真正离开进程的内容，以及真正返回的内容。

## 安装

**npm 是官方支持的安装路径。** 发布的包自带预编译的 `dist/`（发布时由 `pnpm run build` 生成），本地不需要任何构建工具链：

```sh
dsh plugin --profile web add dsh-llm-trace-plugin
```

指定精确版本：

```sh
dsh plugin --profile web add dsh-llm-trace-plugin@0.2.0
```

之后按**包名**更新或卸载：

```sh
dsh plugin --profile web update dsh-llm-trace-plugin
dsh plugin --profile web remove dsh-llm-trace-plugin
```

### 从源码 checkout 安装（git 或 `link:`）

本仓库发布的是 TypeScript 源码，**不**包含提交进版本库的 `dist/`——git 形式的安装或本地 `link:` checkout 拿到的只有源码，而且本插件不声明 `prepare` 脚本，所以没有任何东西会自动帮你构建。（这是刻意的设计：git 依赖上的 `prepare` 脚本需要 pnpm ≥10 明确的 `allowBuilds` 批准才能执行，本质上等于"允许这个包在你安装的这一刻在你机器上跑任意代码"——对一个大多数用户都是从 npm 安装的插件来说，这个风险值得避免。）安装前请自己先构建一次：

```sh
cd /path/to/dsh-llm-trace-plugin
pnpm install
pnpm run build      # 产出 dist/host/** 与 dist/client.js
```

然后像安装任何本地插件一样安装这份 checkout：

```sh
dsh plugin --profile web add link:/path/to/dsh-llm-trace-plugin
# 或者，从固定到某个分支/tag/commit 的 git 远程安装：
dsh plugin --profile web add git+https://github.com/lastorder/dsh-llm-trace-plugin.git#v0.2.0
```

git 形式的安装依然只拉源码——每次 `update` 拉到新提交后都要重新 `pnpm run build`，因为没有任何东西会替你自动构建。

注意事项：

- `dsh plugin` 会转发给 pnpm，随后根据*已安装状态*回填 `$DSH_HOME/profiles/web/package.json` 里的 `dsh.profile.bundles`，因此 git 形式的安装会以本包真实的名字 `dsh-llm-trace-plugin` 登记。
- **安装后需要重启 `dsh web`。** 已安装的包不是开发态 checkout，没有客户端插件的 HMR 监听。
- 包名已从 `dsh-llm-wire-trace-plugin` 改为 `dsh-llm-trace-plugin`。如果你之前是按旧名字安装的，请先卸载：`dsh plugin --profile web remove dsh-llm-wire-trace-plugin`。

## 配置

host 侧的插件行位于 [`cordis.patch.yml`](cordis.patch.yml)，支持以下可选配置项：

| 配置项 | 默认值 | 含义 |
|---|---|---|
| `maxRecords` | `200` | 内存环形缓冲区大小；只在内存中保留最近的 N 条记录。body 同样驻留在内存中，如果你经常发送非常大的请求，可以调低该值。 |
| `maxBodyChars` | `8000000` | 单个字段被截断前的字符上限。该值足以容纳完整的 1M token 上下文（约 400 万字符）并留有 2 倍余量；从中间被截断的 JSON 无法解析，查看器只能按原文显示。 |
| `routePrefix` | `/llm-wire-trace` | 本插件自身 HTTP 路由的前缀。 |
| `persist` | `true` | 将记录写入磁盘，使其在重启后依然存在。设为 `false` 则只保留在内存中。 |
| `traceDir` | `$DSH_HOME/llm-wire-trace/records` | 记录文件的存放目录。 |
| `maxPersistedRecords` | `300` | 磁盘上保留的记录数；超出后删除最旧的。 |
| `historyPageLimit` | `50` | 从磁盘构建一页列表时最多读取的文件数。 |
| `prettyBodyLimit` | `500000` | 超过该大小的 body 不再写入可读副本。 |

```yaml
- insert:
    - id: llm-wire-trace
      name: dsh-llm-trace-plugin
      config:
        maxRecords: 500
        maxBodyChars: 2000000
        maxPersistedRecords: 5000
```

## 持久化

内存中的环形缓冲区会随进程一起消失，而这对一个调试工具来说恰恰是反的：你最想看的，往往正是刚刚崩溃的那次运行留下的 trace。因此记录会同时写入磁盘。

**这里没有「实时 / 历史」两种模式需要你选择。** 列表始终把两者合并：内存提供实时性（正在进行中的 `streaming` 调用，此时还没有最终态文件），磁盘提供纵深（内存环形缓冲区装不下的更早记录，以及上次重启之前的全部记录）。靠近头部的记录在两边同时存在，因此按 id 去重，并让内存中的副本获胜 —— 它们是同一条记录，但内存里的那份正随着响应流式写入而持续变化。一条记录究竟存在哪里，是实现细节，查看器刻意不把它暴露给你。

### 一条记录一个文件，以及为什么

每条记录都是一个自包含的 JSON 文件，只写一次，永不改写：

```
$DSH_HOME/llm-wire-trace/records/<startedAt 毫秒>-<毫秒内序号>-<随机串>.json
```

仅这一个选择，就完全消除了并发控制的需要。看上去更自然的方案 —— 单个 JSONL 追加文件 —— 对**追加**本身是安全的（行级写入不会撕裂），但对为了执行保留上限而定期进行的**重写**并不安全：两个 harness 进程同时压缩同一个文件，会互相丢掉对方的记录。而一条记录一个文件，就根本不存在需要压缩的东西：

- **写入**是 `写临时文件` + `rename`，在 POSIX 上是原子的。读取方要么看到完整文件，要么看不到文件，绝不会看到写了一半的内容。
- **保留策略**就是 `unlink` 最旧的那些文件名。两个进程同时删同一个文件也没有关系 —— 慢的那个拿到 `ENOENT`，直接忽略。不需要锁，不需要按进程分文件，也不需要读取时合并。
- **强杀进程**最多留下一个孤儿 `.tmp` 文件，下次启动时清理。既不存在需要识别并跳过的截断尾行；即使某个文件损坏，也只是跳过它，而不会让整次加载失败。

已通过实测验证：四个进程并发向同一目录写入 600 条记录，期间保留策略反复交错执行，结果是零损坏文件、零 id 冲突、零临时文件残留，且记录数正好落在上限。

文件名中带有时间戳，因此排序和保留都是纯粹的**文件名**操作 —— 列出最新一页只需 `readdir` + 排序 + 切片，完全不打开任何文件。只有真正要展示的记录才会被读取。

> 记录 id 同时用作文件名，因此它是一个可排序的字符串，而不再是原来的进程内计数器（`w1`、`w2`……）。计数器会让两个 harness 进程撞上同一个文件名并静默覆盖彼此的记录 —— 那等于把这套布局本来要消除的问题，以数据丢失的形式又请了回来。
>
> 只用毫秒作为排序键并不够：一次突发可能在同一毫秒内发起多次调用，此时纯随机后缀会让它们的顺序变得**完全随意** —— 恰恰在调用最密集的时候丢掉真实顺序（这个问题在测试中被实际观察到并已修复）。毫秒内序号恢复了同一毫秒内的顺序，随机尾巴则保证跨进程的唯一性 —— 这是单靠计数器做不到的。在该序号出现之前写入的文件仍然可以被读取，因此升级不会丢掉你已有的历史记录。

### 磁盘上是可读的

文件以缩进格式写入，并且每个 body 都存两份：线路上逐字捕获的 `bodyText`，以及紧挨着它的、已解析的 `bodyJson`。只有 `bodyText` 是不够的 —— 它本身是一个 JSON **字符串**，落到磁盘上就是一行超长的转义文本（`\"role\":\"user\"`），任何编辑器都没法好好显示；有了解析副本，`messages`、工具定义和响应对象就能以真正的嵌套 JSON 展开。

`bodyJson` 只是派生出来的便利副本，绝不是事实来源：读取时永远从 `bodyText` 重新解析，因此磁盘上一份过期的、甚至被手工改过的解析结果，都不可能影响查看器显示的内容。在它帮不上忙的情况下会被省略 —— body 被截断、值不是对象或数组，以及 SSE 响应（它是帧序列，不是单个 JSON 值，这与捕获时的规则完全一致）。代价是 body 的字节数大约翻倍。

> **从 0.1.2 升级。** 该版本的 body 上限是 20 万字符，而真实的 agent 请求会超过这个数，因此它存下来的 body 是从 JSON 中间截断的 —— 查看器只能把这类 body 按原文显示。已经以这种方式写入的记录仍然是截断的（缺失的那部分从未被捕获）；升级之后发生的调用会被完整保存。

### 磁盘占用

body 的上限是按 1M token 上下文来定的，因此单条记录可能很大。有两件事在约束目录体积：300 条的保留上限，以及 `prettyBodyLimit` —— 超过 50 万字符后就不再写入解析后的可读副本，因为再大的 body 任何编辑器也无法好好显示，写它只会白白让字节数翻倍。这对查看器没有任何影响：它始终从 `bodyText` 重新解析。

实际情况下，一个典型请求（几十万字符）在 300 条上限下约占 250MB。最坏情况 —— 连续 300 条完整的 1M token 请求 —— 约为 1.3GB。如果这对你的机器有影响，可以调低 `maxPersistedRecords`、`maxBodyChars`，或两者都调。

### 代价，明说

这里没有索引，所以构建一页历史的代价是**该页上**每条记录一次文件读取（受 `historyPageLimit` 限制），而不是每条已保留记录一次。这些读取分批并发执行，并在批与批之间把事件循环让回去 —— 因为本插件的路由与 harness 自己的 Web UI 共处一个进程，也就共用一个事件循环。列表读取只解析行上要显示的那些字段，绝不触碰占了记录绝大部分体积的 body 文本。带 session 过滤的历史扫描会在一个有限预算处停止，此时查看器会明确说明「还有更早的记录未被扫描」，而不是假装已经展示了全部。

这就是这里刻意做出的取舍：用有界的每页开销，换取永不重新引入共享可变状态。

### 启动

`apply` 时不会把任何记录预载进内存环形缓冲区：列表本身已经合并了内存与磁盘，因此重启后打开看到的自然就是最近的历史。（事实上，正是这个预载曾让早期的「实时 / 历史」开关在两种模式下显示出完全相同的内容 —— 内存里装的就是另一种模式要读的那批历史。）

Wire Trace 标签页只有在处于激活状态时才会挂载，因此没被打开的标签页什么都不会读。打开它时，先渲染内存中的实时记录，磁盘历史随后在后台并入 —— 在历史尚未到达期间，界面会明确说明这一点。之后的自动刷新只轮询内存，所以盯着一个实时 session 看，永远不会重新扫描磁盘。

捕获会立即开始，磁盘缓慢或故障都不会拖慢 fetch 补丁，也不会让任何请求失败。持久化过程中的错误会被计数，并通过 `GET <routePrefix>/stats` 汇报，而绝不会抛进捕获链路。

### 隐私：请求体按原样落盘

`authorization` 头在磁盘上同样会被脱敏，与内存中一致。但**请求体和响应体不会** —— 它们按捕获时的原样存储，也就是说你的 prompt、代码，以及上下文中的任何文件内容，都会以明文形式落在 `traceDir` 下的文件里。这是「持久化完整 body」本身固有的结果，对一个本地调试工具而言是刻意的选择。可用的调节手段是 `persist: false`、调小 `maxPersistedRecords`，或降低 `maxBodyChars`。

在查看器中执行「清空」时，磁盘上的副本也会一并删除 —— 否则「清空」会在下次重启后自己变回来。

## 为什么必须是已安装的包，而不是动态 Cordis 插件

动态 Cordis Host package 的代码运行在一个隔离的 `node:vm` realm 中。该 realm 的 `globalThis` **不是**进程真正的 `globalThis`，它的 `fetch` 被硬编码为一个会抛错的陷阱，用来把作者引导至 `ctx.web` —— 按设计，动态 package 根本无法触及、更谈不上替换 `@deepseek-ai/dsh-llm-deepseek` 和 `@deepseek-ai/dsh-llm-pi-ai` 在调用时解析到的那个真实 `fetch`。只有作为普通模块加载进真实进程的代码 —— 也就是像本插件这样的已安装包 —— 才共享那个真实的 `globalThis`。

## 工作原理

1. 在 `apply` 时，用一个包装函数替换 `globalThis.fetch`，并保留原始引用。`ctx.effect` 把 disposer（负责恢复原始引用）绑定到插件的 fiber 上，因此停止、卸载或激活失败都不会留下一个悬空的、已被打补丁的 `fetch`。
2. 每次调用都会检查其外发的 `user-agent` 头是否以 `deepseek-harness/` 开头 —— 这是 `attributionHeaders()` 给*每一个*提供方请求都会打上的值，与由哪个适配器发出无关（参见 `@deepseek-ai/dsh-llm` 的 `APP_IDENTITY`）。其他所有请求（`web_fetch` 工具、`web_search`、MCP 传输……）都会完全原样透传：不记录、不克隆，参数相同，返回值相同。
3. 对于匹配到的调用，先执行真实的 `fetch`。那个**原始的、未被读取过的** `response` 会原封不动地交回给适配器 —— 它的 SSE 解析、计时和错误处理完全不受影响。
4. 在后台镜像一份 `response.clone()`（绝不在热路径上 `await`），从而在不干扰适配器正在读取的原始流的前提下捕获响应体。

两个随附的适配器（`dsh-llm-deepseek`、`dsh-llm-pi-ai`）都是直接调用裸的 `fetch` 标识符、没有本地 import，因此它们在调用时解析到的就是当时的 `globalThis.fetch` —— 这正是本补丁无论模块加载顺序如何都能生效的原因。

## 安全性

包装函数在编写时保证了以下性质：

- 非提供方的调用直接透传：不记录、不克隆，响应体对它自己的调用方完整无损。
- 提供方调用的调用方依然能读到完整、未经修改的响应体 —— 镜像永远不会与之争抢。
- 传输失败（底层 `fetch` 抛错）会被记录并**原样重新抛出** —— 绝不吞掉。
- `authorization` 在存储或展示前一律脱敏为 `Bearer ***redacted***`；其他请求头不作任何改动。
- 重新激活插件不会对已经打过补丁的 `fetch` 二次包装（而是显式抛错）；停止时会恢复那个确切的原始引用。

## 捕获的内容

每条记录：

```
{
  id,                            // '<毫秒>-<序号>-<随机串>'，同时用作存储文件名
  startedAt, endedAt, durationMs,
  status: 'ok' | 'http-error' | 'transport-error' | 'streaming',
  model,                          // 尽力而为，从解析后的请求体中读取
  sessionId,                      // 所属 session；无法归属时为 null
  turn, step,                     // harness 坐标；不适用时为 null
  purpose,                        // 'session-title' | 'compaction' | null
  provider, requestedModel,       // 解析到的 harness 路由
  attributed,                     // 这次调用是否经过了 ctx.llm
  request:  { method, url, headers /* 已脱敏 */, bodyText, bodyJson, bodyTruncated },
  response: { status, statusText, headers, contentType, bodyText, bodyJson, bodyTruncated } | null,
  error: { name, message } | null,
}
```

- `bodyText` 始终是原始字符串（逐字保留的 SSE 帧，或 JSON 错误体）。`bodyJson` 是为 JSON 视图做的尽力解析；SSE 响应体永远不会被作为整体去 JSON 解析（它是一个帧序列，而不是单个 JSON 值）。
- `sessionId` / `turn` / `step` / `purpose` **不是从线路上读到的** —— 线路上几乎没有这些信息。它们是通过观测两个 harness 通道后附加上去的，见 [harness 坐标](#harness-坐标turn--step)。
- 响应体字段有字符上限，环形缓冲区也只保留最近的若干条；两者都可配置（见[配置](#配置)）。记录同时会写入磁盘，在进程重启后依然存在 —— 见[持久化](#持久化)。

## 查看器

一个 `jq` 形态的 JSON 视图：括号、逗号、缩进都与 `jq .` 的输出一致，并带有取自产品自身 shiki 调色板的语法着色，因此能自动跟随明暗主题。key、字符串、数字、布尔、`null` 各有自己的颜色。与预格式化的死文本不同，这里每一行都是真实的可交互行，因此容器始终可折叠。

折叠有两套控件，可以叠加使用：

- **全局深度步进器**（工具栏上的 `−` / `+`）：整体展开或收起一层，旁边以 `深度 2/5` 显示当前层级。`+` 到达内容实际的最深层级后即停止。
- **行首的 `+` / `-`**：单独折叠某一个容器，适合只想展开某一支、而不想把整层都摊开的场景。

使用全局步进器会重设基准层级并清空所有行首折叠状态，因此深度读数始终如实描述你当前看到的内容。

折叠后的容器会收成一行占位符，并保留其尾随逗号，例如 `"messages": [ … 12 items ],`。完全展开时，该视图就是合法的 JSON：经 `JSON.parse` 可原样还原为捕获到的值。

包含 Request 和 Response 两个标签页。Request 始终显示解析后的请求体。Response 则依据内容类型自适应：JSON 响应体原样显示，而 `event-stream` 响应体默认会被*重新组装*——把散落的 delta 增量合并回一份完整、可读的结构，再用同一套 JSON 视图显示（见下）。

> 应用内的按钮文案目前是中文。

### harness 坐标（turn / step）

线路只能告诉你**发出了哪些字节**，回答不了真正关心的问题：**这是第几轮对话？是这一轮里的第几步？这次调用究竟是不是用户要的？** 而这些信息几乎都不在线路上 —— `dsh-llm-deepseek` 只发一个 session-id 头，`dsh-llm-pi-ai` 什么都不发。

所以本插件通过两个公开的插件扩展点把它们**附加**上去。**不修改 dsh 任何源码**，两个通道都是纯观测。

**1. `llm/stream` —— 这是哪一次调用？**
它是包裹每次模型调用的 waterfall，其 `options` 带有 `sessionId`、`provider`、`model` 和 `purpose`。监听器在 `AsyncLocalStorage.run` 里**逐次拉取**被包裹的流，因此适配器的 `fetch` 看到的正是它自己那次调用的身份。它原样按序 yield 收到的 chunk，不改变任何其他行为。

> 只包裹流的**构造**是抓不到东西的：异步生成器的函数体运行在消费者的 tick 上，等适配器真正发 `fetch` 时上下文早就没了。这一点是实测验证过的，不是假设。

**2. `session/event` —— 这是第几轮第几步？**
循环会在模型调用**之前**追加 `step/start`、**之后**追加 `step/end`，所以一次调用开始时处于打开状态的 step 就是它所属的 step。两个 step 之间，插件报告 `null`，而不是刚刚结束的那个。

#### 为什么这是精确的，而不是猜的

每次调用各自处在自己的异步上下文分支上，因此**并发调用之间不会互相污染** —— 包括那个足以击垮朴素时间窗关联的场景：一次 turn 正在进行时，**同一个 session** 上并发触发的后台 `session-title` 请求。带 `purpose` 的调用（`session-title`、`compaction`）会被刻意**完全不赋予 turn/step**，因为即使它和某轮对话在时间上重叠，它也不属于对话循环。

没有经过 `ctx.llm` 的调用会被记为 `attributed: false` 且坐标为 null —— 如实报告为无归属，绝不给它安一个看起来合理的主人。

#### 页面上怎么呈现

- 每行以坐标开头：`T1·S0`，或用途标签（后台辅助调用），或「无归属」。
- 行按 turn 分组，组头吸顶，并显示该轮的调用数与 step 数。
- 选中的记录在正文上方有一条坐标条（Turn / Step / Provider / Session）。
- 工具栏汇总 `… · N turn · N 辅助`。

#### 依赖

需要 `sessions` 与 `llm` 服务。两者都是可选的：没有它们时抓包照常工作，只是没有坐标。

### 按 session 过滤

标签页打开时默认只显示**当前 session** 的调用。工具栏上有一个按钮，可在「当前 Session」与「全部 Session」之间一键切换。

过滤依据是记录上的 `sessionId`，它来自上面说的 `llm/stream` 上下文（若某次调用没走 `ctx.llm`，则回退到 `x-deepseek-harness-session-id` 请求头）。由于主要来源是 harness 调用本身而不是线路，**它对所有 provider 都有效，包括线路上什么都不带的 pi-ai 路线。** 过滤在宿主端完成，因此其他 session 的请求/响应体根本不会传到浏览器。

有两点值得注意：

- **并非每次调用都能归属。** 没有经过 `ctx.llm` 的请求没有 session。这些记录在过滤下会被隐藏，但绝不会悄无声息：列表底部会写明还有多少条，并指向「全部 Session」。在那里，每一行都会标注 本 session / session `<id 前缀>` / 无 session。
- **子代理是独立的 session。** 子代理的 LLM 调用带的是它自己的 session id，因此不会出现在父会话的过滤视图里。切到「全部 Session」即可看到。

「清空」不受过滤影响 —— 它始终清空全部记录。

作为兜底：如果首次加载发现本 session 一条可归属记录都没有、却存在无归属记录，就会自动回退到「全部 Session」并说明原因。该回退最多发生一次，你只要自己动过那个开关，它就不再生效。

### Response：合并后的 SSE，以及底下的原始线路文本

原始 SSE 流本身几乎没法直接阅读：一次回复通常被拆成几十到几百个帧，每一帧只带一两个字符的文本。所以本插件默认会*重新组装*一个 `event-stream` 响应再展示 —— 把每个 delta 增量合并回**该 provider 自己非流式响应本来的形状**，再用与 Request 完全相同的 JSON 树展示（同样的折叠、同样的复制/下载）。特意复用官方形状：读者只要已经熟悉一个普通的 Anthropic 或 OpenAI 响应长什么样，看合并后的结果就不需要学任何新词汇。

每个 provider 形状对应一个小小的独立适配器模块（`sse-merge/anthropic.ts`、`sse-merge/openai-responses.ts`、`sse-merge/openai-chat-completions.ts`），每一帧都会依次交给它们尝试，谁认得出这个形状就由谁合并进去。以后要支持第四种 provider 形状，只需要新增一个适配器文件——其他任何地方都不用改。目前能识别三种结构，无需告诉插件这是哪个 provider：

**OpenAI/DeepSeek Chat Completions**（带顶层 `choices` 数组的对象）合并进 `chatCompletion`，形状与 SDK 自己的 `ChatCompletion` 一致：

```json
{
  "anthropic": null,
  "responses": null,
  "chatCompletion": {
    "id": "chatcmpl-...",
    "object": "chat.completion",
    "model": "deepseek-...",
    "choices": [
      {
        "index": 0,
        "message": {
          "role": "assistant",
          "content": "拼接自每个 delta.content 增量的完整回复正文",
          "reasoning_content": "如果 provider 发送了推理内容（DeepSeek 自己的扩展字段），这里是完整的推理正文",
          "tool_calls": [
            { "id": "call_1", "type": "function", "function": { "name": "search", "arguments": "{\"q\":\"...\"}" }, "argumentsJson": { "q": "..." } }
          ]
        },
        "finish_reason": "stop"
      }
    ],
    "usage": { }
  },
  "frameCount": 137,
  "recognizedFrameCount": 135,
  "sawDone": true,
  "unrecognized": []
}
```

content 和 reasoning-content 的增量按线路顺序拼接；工具调用被拆分的 `function.arguments` 同样按顺序拼接，最后整体解析一次，合入（并非官方字段、但几乎总是读者接下来想要的）`argumentsJson` 便利字段——而不是某个片段的局部解析结果。

**Anthropic Messages API**（按 `event:` 类型分帧 —— `message_start` / `content_block_start` / `content_block_delta` / `content_block_stop` / `message_delta` / `message_stop`）合并进 `anthropic`，形状与非流式的 `POST /v1/messages` 响应一致：

```json
{
  "anthropic": {
    "id": "msg_...",
    "type": "message",
    "role": "assistant",
    "model": "claude-...",
    "content": [
      { "type": "text", "text": "拼接自每个 text_delta 增量的完整回复正文" },
      { "type": "thinking", "thinking": "如果模型使用了扩展思考，这里是完整的思考正文", "signature": "..." },
      { "type": "tool_use", "id": "toolu_...", "name": "bash", "input": { "command": "..." }, "inputJsonText": "{\"command\":\"...\"}" }
    ],
    "stop_reason": "tool_use",
    "stop_sequence": null,
    "usage": { }
  },
  "responses": null,
  "chatCompletion": null,
  "frameCount": 19,
  "recognizedFrameCount": 17,
  "sawDone": true,
  "unrecognized": []
}
```

每个 content block 的 `text` / `thinking` / `partial_json` 增量按线路顺序拼接，以 block 自身的 index 为归属；`tool_use` block 被拆分的 `partial_json` 会整体解析一次，合入官方字段 `input`，解析失败时原始拼接文本仍保留在 `inputJsonText` 里。`message_start` 里的顶层字段（id、model、role、usage 等）会被收进来，`message_delta` 追加的内容（包括 provider 私有的额外字段）也会一并合入——所以真实记录里的 `copilot_usage` 之类扩展字段依然会出现，只是作为官方字段之外的额外字段。

**OpenAI Responses API**（同样按 `event:` 类型分帧，但用的是另一套名字 —— `response.created` / `response.output_item.added` / `response.output_text.delta` / `response.function_call_arguments.delta` / `response.reasoning_text.delta` / `response.reasoning_summary_text.delta` / … / `response.completed`）合并进 `responses`，形状与非流式的 `POST /v1/responses` 响应一致：

```json
{
  "anthropic": null,
  "responses": {
    "id": "resp_...",
    "object": "response",
    "model": "gpt-5...",
    "status": "completed",
    "output": [
      { "type": "reasoning", "id": "rs_...", "summary": [ { "type": "summary_text", "text": "..." } ], "content": null },
      { "type": "message", "id": "msg_...", "role": "assistant", "content": [ { "type": "output_text", "text": "完整的回复正文" } ] },
      { "type": "function_call", "id": "fc_...", "call_id": "call_...", "name": "search", "arguments": "{\"q\":\"...\"}", "argumentsJson": { "q": "..." } }
    ],
    "usage": { }
  },
  "chatCompletion": null,
  "frameCount": 11,
  "recognizedFrameCount": 11,
  "sawDone": true,
  "unrecognized": []
}
```

每个 output item 以自己的 `output_index` 为归属，合并进对应的官方 item 形状（`message` / `reasoning` / `function_call`）。`reasoning` item 的 `summary[]`（来自 `response.reasoning_summary_text.delta`）和 `content[]`（来自 `response.reasoning_text.delta`）是两个各自独立的官方字段——具体哪个会被填充取决于模型/账号，只有 provider 实际发送的那个才会有内容，另一个保持 `null`/`[]`，不会被凭空编造。`function_call` 的 `arguments` 按线路顺序拼接，最后整体解析一次合入 `argumentsJson` 便利字段；`response.output_item.done` 还额外提供了一份兜底的整体读取，覆盖本插件的增量处理可能遗漏的字段，因此无论哪种情况调用参数都能完整呈现。

任何这三套结构都识别不了的东西都不会被强行凑进去 —— 错误事件、无法识别的 `event:` 类型、`[DONE]` 哨兵、无法解析的载荷，都会原样进入 `unrecognized`，保证插件看不懂的内容也绝不会被悄悄丢弃。

一个开关（`原始 SSE` / `优化展示`）可以切换到线路上真实的帧序列 —— 每一帧一个对象，键名就是 SSE 协议自身的字段名，与捕获时完全一致 —— 当你确实需要原始字节时使用：

```json
[
  { "comment": "keep-alive" },
  { "data": { "id": "chatcmpl-1", "choices": [ ] } },
  { "event": "message", "id": "42", "data": { } },
  { "data": "[DONE]" }
]
```

`data:` 在载荷可解析时存放解析后的 JSON，否则存放原始字符串，因此像 `[DONE]` 这样的哨兵不会被丢弃而是照常可见；`event:` / `id:` / `retry:` 作为同级键并列，注释行（`: keep-alive`）则成为 `comment`。同一帧内重复出现的 `data:` 行会先按 SSE 规范用换行符拼接再解析。任何内容都不会被丢弃 —— 无法解析的载荷会以字符串形式逐字保留。该模式下只有每一帧的 `data:` 载荷会被重新缩进；帧结构完全保持原样。

### 复制为 curl

`复制 curl` 按钮会向 host 请求一条依据该记录重建的、可直接运行的 `curl` 命令（`GET <routePrefix>/curl?id=`），并复制到剪贴板。每个参数都使用标准 POSIX 的 `'\''` 转义进行单引号包裹，因此该命令可以原样粘贴进 bash/zsh/sh 运行，即使请求体中包含引号、`$(...)` 或反引号也没问题。

存储下来的 `authorization` 头始终是脱敏占位符 —— 本插件从不在静态存储中保留真实密钥 —— 因此该请求头会在生成 curl 命令时重新构造，有两种方式：

- **解析到了真实值**，按以下顺序检查：
  1. 进程环境中的 `DSH_CURL_KEY` —— 一个由插件自身提供、与提供方无关的手动覆盖项，对**任何**请求都有效，无论它发往哪个提供方或主机。优先检查它，以保证显式覆盖总能生效。
  2. 专门针对 `https://api.deepseek.com`，采用与 `dsh-llm-deepseek` 适配器自身相同的密钥解析方式：先 `ctx.credentials`，再是环境变量 `DEEPSEEK_API_KEY`。

  无论哪种方式，密钥都会像其他请求头一样被单引号包裹后直接内联 —— 粘贴即可运行，无需再编辑。
- **两条路径都没找到**：该请求头会变成 `"authorization: Bearer $DSH_CURL_KEY"` —— 使用双引号，以便 shell 在运行时展开该变量；并且无论记录对应哪个提供方或主机，都始终使用这一个变量名。只需 `export DSH_CURL_KEY=...` 一次，复制出来的命令对**任何**记录都能原样运行；这正是该功能主要面向的场景。

每次复制后，客户端都会告诉你属于上述哪一种情况。内联真实密钥意味着**它现在就在你的剪贴板里**（粘贴后还可能进入 shell 历史）—— 在共享屏幕或粘贴到聊天工具前值得留意。`$DSH_CURL_KEY` 那种情况从设计上避免了这一点，因为真实密钥的值始终不会离开你 shell 的环境变量。

### 复制与下载

`复制` 会把当前这一半完整记录 —— 整个 `request` 或 `response` 对象，含请求头 —— 以格式化 JSON 放入剪贴板，与视图所显示的内容一致。`下载` 则把完整记录（两半都在）导出为 `llm-wire-trace-<id>.json`。

### 独立滚动：本插件需要修正的一个外壳 CSS 怪癖

左侧记录列表与右侧详情面板本应各自独立滚动，但外壳自身的 `ConversationRoot` CSS 会造成阻碍：对于任何已打开的非空白会话（`data-phase="active"` —— 对我们来说就是永远如此），它会把那个被称为 `viewArea` 的祖先元素设为 `flex:1 0 auto; min-height:auto`。这对 Chat 是有意为之 —— 它让消息列表可以超出可视区域生长，从而使*整个页面*滚动、并把输入框粘性固定在底部 —— 但同一条规则不可避免地会作用到每一个 `conversation.view` 条目，包括本插件，进而破坏双栏布局：由于没有一个有界高度可供溢出，根元素会撑到与内容等高，整个页面变成一起滚动。

`viewArea` 没有自己的稳定选择器（它的类名是构建时哈希的 CSS module 类），因此本插件的样式表转而通过结构来定位它，依据是框架自身始终会添加、并视为稳定的两个属性：每个 slot 的 `SlotOutlet` 包装元素都带有 `data-slot="<slot key>"`，这使得 `viewArea` 恰好就是 `div:has(>[data-slot="conversation.view"])`，与它自身的类名无关。再用 `:has(.wt-root)` 限定作用范围，就只会在*本*标签页正挂载于其中时才重新声明 `min-height:0; overflow:hidden; flex:1 1 0` —— Chat、Trajectory 以及任何其他标签页所对应的同一祖先元素都不受影响。

## 已知限制

本插件依赖于这样一个实现细节：当前所有的提供方适配器都调用裸的、未经 import 的 `fetch`。如果未来某个适配器改用自带的 HTTP 客户端（例如某个 SDK 内置了自己的 `undici` 实例），它对本补丁就是不可见的 —— 而且是静默不可见，不会报错。这是 fetch 补丁这一方案的固有局限，而非本插件的缺陷。

harness 坐标（turn / step）另有一层不同的依赖：它们来自 `llm/stream` 与 `session/event` 两个通道，而不是 fetch。因此**不经过 `ctx.llm` 的调用可以被抓包、却无法被归属**（记为 `attributed: false`）；反过来，某个绕开裸 `fetch` 的适配器会同时丢失抓包与坐标。两者都属于如实报告的缺口，不会被猜测填补。

## 仓库结构

源码使用 TypeScript 按职责拆分模块；`dist/` 是真正被安装和加载的、编译后的纯 JavaScript 产物 —— 见下方[开发](#开发)一节。

```
src/host/                    host 半边（Node ESM，由 tsc 逐文件编译）
  index.ts                    apply(ctx, config) —— 把各模块组装起来
  constants.ts                共享常量（user-agent 前缀、header 名、默认值）
  http-utils.ts               header 脱敏、请求解析、JSON/body 裁剪
  call-context.ts             围绕 llm/stream 的 AsyncLocalStorage 绑定（turn/step/purpose/provider）
  step-tracker.ts              基于 session/event 的 turn/step 跟踪
  fetch-patch.ts                globalThis.fetch 补丁本身
  curl.ts                       curl 命令渲染与密钥解析
  store.ts                      内存环与持久化归档的合并视图
  page-grouping.ts              列表分页分组（turn、辅助调用、无归属统计）
  routes.ts                     HTTP 路由处理（list/stats/get/curl/clear）
  persistence/                  一条记录一个文件的持久化存储
    naming.ts                   文件命名与 trace 目录解析
    codec.ts                    记录 ⇄ 持久化 JSON 互转
    archive.ts                  实际的文件 I/O（save/list/get/restore/sweep/clear）
    constants.ts
src/client/                   浏览器半边（由 esbuild 打包为单个经典脚本）
  entry.ts                     window.__ModuleLoader__.load({ id, factory }) 包裹
  wire-trace-view.ts            WireTraceView 组件（状态与渲染）
  json-view.ts                   可折叠 JSON 树组件
  json-model.ts                   纯 JSON 展平数据模型（不含 DOM）
  format.ts                       标签/格式化函数（turn 徽标、session 标签、时间戳）
  sse.ts                           原始 SSE 帧解析/美化打印
  sse-merge/                        按 provider 拆分的适配器，把 SSE 增量合并回该 provider 自己的非流式响应形状
    shared.ts                        适配器公共接口 + JSON 解析工具函数
    anthropic.ts                     Anthropic Messages API 适配器
    openai-responses.ts              OpenAI Responses API 适配器
    openai-chat-completions.ts       OpenAI/DeepSeek Chat Completions 适配器
    index.ts                         把每一帧分发给各适配器，汇总成统一结果
  api-client.ts                     本插件自身路由的 fetch 封装
  styles.ts                         标签页样式
  constants.ts
src/shared/
  record-shape.ts              两个半边共享的仅类型记录结构
dist/                         编译产物 —— 真正发布和加载的内容
  host/**                      tsc 输出，逐文件对应
  client.js                     esbuild 打包 src/client/** 后的单个 IIFE
cordis.patch.yml              host 组合中的插件行（dsh.bundle.patch）
package.json                  dsh.bundle 与 dsh.client 声明
test/                          node:test 测试套件，与 src/host/** 及不含 DOM 的 src/client/*.ts 逐文件对应
AGENTS.md                      给 agent/贡献者看的自验证流程、模块边界与硬性约束
docs/plugin-development.zh.md 本仓库如何使用 DSH/Cordis 插件框架
docs/architecture.zh.md       本仓库自己的模块为什么这样拆分
```

## 开发

```sh
pnpm install
pnpm run build       # tsc -> dist/host/**，esbuild -> dist/client.js
pnpm run typecheck   # host + client，仅类型检查不产出文件
pnpm run test        # tsc -> .test-build，node --test
pnpm run verify       # build + typecheck + test —— 认为一次改动完成前的完整自验证
```

`dist/` **不**纳入版本控制——它和其他构建产物一样被 gitignore 掉，由 `pnpm run build` 生成，发布时由 `prepublishOnly` 脚本重新生成一份（确保 `npm publish` 每次都发布与该提交源码完全对应的构建结果）。只有*发布出去的 npm 包*才自带预编译的 `dist/`；git checkout 或 `link:` 安装永远不会自带。这两种安装方式意味着什么，见上文"[从源码 checkout 安装](#从源码-checkout-安装git-或-link)"一节。

本地开发时，每次改动源码后都要运行一次 `pnpm run build`（这份 checkout 本身要能跑起来就得先构建——没有提交进版本库的 `dist/` 可以兜底），然后重新安装 `link:.` checkout（或者直接重启 `dsh web`，因为被链接的包的 `dist/` 不在 client-plugin 的 HMR 监听范围内）。

### 测试

`test/` 与 `src/host/**`、`src/shared/**`，以及不含 DOM 的 client 模块（`format.ts`、`json-model.ts`、`sse.ts`、`sse-merge/**`）逐文件对应，用 Node 内置的测试运行器（`node:test`）——不引入任何测试框架依赖。覆盖范围包括：内存 store 与伪造 archive 的合并逻辑、持久化层用真实临时目录做的文件 I/O、turn/step 归属用到的 `AsyncLocalStorage` 上下文绑定，以及每个 SSE 合并适配器针对合成数据和一个本项目真实修过的 bug 的精确复现（一个 `message` item 自己的 id 被误判成 tool-call id）。

刻意不做单元测试的部分：`src/host/index.ts` / `src/client/entry.ts`（纯 Cordis/`ModuleLoader` 胶水，靠 `build`+`typecheck` 成功来覆盖）和依赖真实 DOM/React 的 client 模块（`api-client.ts`、`styles.ts`、`json-view.ts`、`wire-trace-view.ts`），改用本项目开发过程中一直使用的"伪 React + 伪 `ModuleLoader` + 真实 `dist/client.js`"模式手工验证。

一次改动完成前必须走完的确切自验证流程、测试目录布局依赖的模块边界，以及保护本项目既有设计取舍的硬性约束（不加 `prepare` 脚本、`dist/` 保持是 gitignore 掉的构建产物、body 逐字存储），见 [`AGENTS.md`](AGENTS.md)（英文）。

关于本项目自身如何使用 DSH/Cordis 插件框架——服务、事件、Slot，以及只有已安装包才能做的那一件事（补丁 `fetch`）——的简短讲解，见 [`docs/plugin-development.zh.md`](docs/plugin-development.zh.md)。关于本项目自己的模块为什么这样拆分、数据如何在它们之间流动，见 [`docs/architecture.zh.md`](docs/architecture.zh.md)。

## 许可证

[MIT](LICENSE)
