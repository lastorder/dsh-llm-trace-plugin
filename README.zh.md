# dsh-llm-trace-plugin

[English](README.md) | 中文

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件，用于捕获每一次 LLM 提供方调用的**原始 HTTP 请求与响应** —— 线路上真实的字节、提供方原生的字段名、未经处理的 SSE 帧 —— 并在 **Wire Trace** 会话标签页中浏览它们。

本插件工作在 *wire（线路）* 层。harness 层的追踪器观察的是 harness 构建出来的、已归一化的 `GenerateOptions` / `StreamChunk` 对象：与提供方无关，且带有 `sessionId` / `turn` / `step` 信息。而本插件完全没有 harness 层的概念 —— 它只看到真正离开进程的内容，以及真正返回的内容。

## 安装

直接从 npm 安装：

```sh
dsh plugin --profile web add dsh-llm-trace-plugin
```

指定精确版本：

```sh
dsh plugin --profile web add dsh-llm-trace-plugin@0.1.4
```

或者直接从 git 安装：

```sh
dsh plugin --profile web add git+https://github.com/lastorder/dsh-llm-trace-plugin.git
```

用 fragment 指定分支或 tag：

```sh
dsh plugin --profile web add git+https://github.com/lastorder/dsh-llm-trace-plugin.git#main
dsh plugin --profile web add git+https://github.com/lastorder/dsh-llm-trace-plugin.git#v0.1.4
```

本地开发时可以链接一份 checkout（相对路径会锚定到你运行 `dsh` 的目录，而不是 profile 目录）：

```sh
dsh plugin --profile web add link:.
```

之后按**包名**更新或卸载：

```sh
dsh plugin --profile web update dsh-llm-trace-plugin
dsh plugin --profile web remove dsh-llm-trace-plugin
```

注意事项：

- `dsh plugin` 会转发给 pnpm，随后根据*已安装状态*回填 `$DSH_HOME/profiles/web/package.json` 里的 `dsh.profile.bundles`，因此 git 形式的安装会以本包真实的名字 `dsh-llm-trace-plugin` 登记。
- **安装后需要重启 `dsh web`。** 已安装的包不是开发态 checkout，没有客户端插件的 HMR 监听。
- 本插件只包含纯 JavaScript，且**没有声明 `prepare` 脚本**，所以 git 安装不需要在 profile 的 `pnpm-workspace.yaml` 里添加 `allowBuilds` 条目 —— git 插件通常会触发的构建放行提示在这里不适用。
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

包含 Request 和 Response 两个标签页。Request 始终显示解析后的请求体。Response 则依据内容类型自适应：JSON 响应体原样显示，而 `event-stream` 响应体会被按帧解析成一个个对象，使整条流读起来就是一个 JSON 数组（见下）。

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

### Response：把 SSE 显示为 JSON 数组

`event-stream` 类型的响应体会被逐帧解析成一个 JSON 数组，并使用与其他响应体相同的视图显示。每一帧成为一个对象，其键名就是 SSE 协议自身的字段名：

```json
[
  { "comment": "keep-alive" },
  { "data": { "id": "chatcmpl-1", "choices": [ ] } },
  { "event": "message", "id": "42", "data": { } },
  { "data": "[DONE]" }
]
```

`data:` 在载荷可解析时存放解析后的 JSON，否则存放原始字符串，因此像 `[DONE]` 这样的哨兵不会被丢弃而是照常可见；`event:` / `id:` / `retry:` 作为同级键并列，注释行（`: keep-alive`）则成为 `comment`。同一帧内重复出现的 `data:` 行会先按 SSE 规范用换行符拼接再解析。任何内容都不会被丢弃 —— 无法解析的载荷会以字符串形式逐字保留。

`SSE 原始文本` 开关可切换到线路上真实的帧序列，而这正是本插件存在的意义。在该模式下只有每一帧的 `data:` 载荷会被重新缩进；帧结构（`event:` / `id:` / `retry:` 字段、注释行、空行分隔符，以及非 JSON 哨兵）完全保持原样。

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

```
src/index.js       host 半边 —— fetch 补丁、记录存储与 HTTP 路由
src/persistence.js 持久化存储 —— 一条记录一个 JSON 文件、保留策略与恢复
src/client.js      浏览器半边 —— Wire Trace 标签页，手写的 bundle 格式
cordis.patch.yml   host 组合中的插件行（dsh.bundle.patch）
package.json       dsh.bundle 与 dsh.client 声明
```

没有构建步骤：两个半边都是纯 JavaScript，原样提供与加载。

## 许可证

[MIT](LICENSE)
