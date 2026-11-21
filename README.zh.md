# dsh-llm-trace-plugin

[English](README.md) | 中文

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：记录每一次 LLM 提供方调用的**原始 HTTP 请求与响应**——线路上的真实字节、提供方原生的字段名、未经处理的 SSE 帧——并在会话的 **Wire Trace** 标签页中浏览。

它工作在线路（wire）层：只看真正离开进程的内容和真正返回的内容，并给每次调用标上它所属的 session、轮次（turn）和步骤（step）。

## 安装

从 npm 安装。发布的包自带预编译的 `dist/`，本地不需要任何构建工具链：

```sh
dsh plugin --profile web add dsh-llm-trace-plugin     # 末尾加 @<版本号> 可固定版本
dsh plugin --profile web update dsh-llm-trace-plugin
dsh plugin --profile web remove dsh-llm-trace-plugin
```

**从源码 checkout 安装**（`link:` 或 git spec）只能拿到源码：仓库没有提交 `dist/`，也没有任何东西会替你构建。请先构建，之后每次 update 拉到新提交都要重新构建：

```sh
cd /path/to/dsh-llm-trace-plugin && pnpm install && pnpm run build
dsh plugin --profile web add link:/path/to/dsh-llm-trace-plugin
# 或：dsh plugin --profile web add git+https://github.com/lastorder/dsh-llm-trace-plugin.git#v<版本号>
```

- **安装或更新后请重启 `dsh web`（或 DSH）。** 插件管理器会立即应用新版本，但旧版本的 `fetch` 包装函数可能仍留在进程里、继续记录重复的调用，直到重启为止。
- 必须作为已安装的包使用，不能做成动态 Cordis 插件：动态插件运行在隔离的 realm 里，碰不到进程真正的 `fetch`。
- 包名已从 `dsh-llm-wire-trace-plugin` 改为现名。如果之前按旧名安装过，请先卸载：`dsh plugin --profile web remove dsh-llm-wire-trace-plugin`。

## 捕获哪些内容

满足以下**任一**条件的请求会被记录：`user-agent` 以 `deepseek-harness/` 开头（harness 发出的每个提供方请求都带这个值），**或者**它是在一次模型调用（`llm/stream`）内部发出的——后者用来兜住那些自行改写 user-agent 的提供方。其他请求（`web_fetch`、`web_search`、MCP 传输……）一律原样放行，不做记录。

每条记录包含方法、URL、请求头、完整的请求体与响应体、HTTP 状态、耗时、模型和提供方，以及这次调用所属的 session、轮次、步骤和用途（见[轮次与步骤坐标](#轮次与步骤坐标)）。凭据会被脱敏——见[隐私](#隐私)。

## 工作原理

- 插件启动时包装 `globalThis.fetch`；停止或卸载时恢复原来的函数。
- 提供方适配器拿回的是原始的、未被读取过的响应，它的流式处理、计时和错误处理都不受影响。响应体通过在后台读取一份克隆来捕获——即使适配器在收到最后一个事件后主动中断了流，也能完整保存。
- 请求体无论以何种形式到达 `fetch`（字符串、字节、`Blob`、流、`Request`）都能捕获。无法在不消费它的前提下复制的形式（`FormData`、异步可迭代对象）会原样发出，并在记录中标注。
- 传输错误会被记录，并原样重新抛出。

模块结构与设计取舍见 [`docs/architecture.zh.md`](docs/architecture.zh.md)。

## Wire Trace 标签页

在任意会话中打开 **Wire Trace** 标签页。界面文字与提示跟随 DSH 的语言设置（设置 → 通用 → 语言）。

### 调用列表

- 列表**只显示当前 session 的调用**。过滤在 host 端完成，其他 session 的请求体和响应体根本不会传到浏览器。子代理是独立的 session，不会出现在父会话的列表里。
- 记录按轮次分组，组头吸顶。每行以坐标开头：`T1·S0`、后台调用标签（会话标题、上下文压缩），或「无归属」。
- 无法归属到任何 session 的调用会被隐藏，列表底部会写明有多少条。如果首次加载时本 session 一条记录都没有、却存在无归属记录，标签页会自动回退为显示全部记录并说明原因（每次打开最多一次）。
- 工具栏显示「命中数 / 全部记录数」，以及轮次数和后台调用数；点击可查看详细说明。
- 新调用会自动出现，流式进行中的调用会自动刷新（标签页可见时每 3 秒轮询一次）。
- **清空**只删除当前 session 的记录。要清除全部记录，请使用[插件管理面板](#插件管理面板)上的**清除全部历史记录**。

### Request 与 Response

详情区显示该调用的模型、状态、开始时间、耗时、HTTP 状态、方法与 URL，一条坐标条（turn / step / provider / session），以及三个标签页：**Request**、**Response** 和**对比**。

请求体和响应体以 `jq` 风格的 JSON 树展示，配色跟随 DSH 主题。可以用深度步进器（`−` / `+`）整体逐层展开或收起，也可以用每行的 `+` / `-` 单独折叠某个节点。完全展开时，视图本身就是合法的 JSON。

流式（`text/event-stream`）响应**默认显示合并结果**：把散落的 delta 增量重新组装成该提供方非流式响应本来的形状。

- **Anthropic Messages** → 一个 `/v1/messages` 消息：text、thinking 与 `tool_use` 块，工具输入已解析。
- **OpenAI Responses** → 一个 `/v1/responses` 响应：`message`、`reasoning` 与 `function_call` 输出项。
- **OpenAI / DeepSeek Chat Completions** → 一个 `chat.completion`：content、`reasoning_content` 与工具调用，参数解析到 `argumentsJson`。

格式按帧自动识别。不属于以上任何一种的帧（错误事件、`[DONE]`、未知事件）会原样保留在 `unrecognized` 里。点击**显示原始 SSE**可切换为线路上的原始帧序列，每帧一个对象。

### 对比

**对比**标签页显示请求体相对另一次调用发生了什么变化——连续几次调用发出的请求几乎一样、又都很大，这正是最常想问的问题。

- 默认基准是「上一次同类请求」（同一 session、同一用途），中间夹着的后台调用会被跳过。也可以在**对比基准**下拉框里任选一次调用（按轮次分组，基准行带「基准」标记），点**恢复默认**即可回到默认基准。对比页打开时在列表中切换记录，仍停留在对比页，方便逐步翻看一轮里的每一步。
- 变化按顶层 key（`messages`、`tools`……）分组并计数。被修改的字符串原地高亮；多行文本（如 system prompt）显示为行级 diff。未变化的顶层字段折叠列出。key 的顺序不算变化。
- **复制**会把变化清单复制为纯文本。两边都必须是合法 JSON；若有一边被截断，标签页会指明是哪一边。

### 复制、下载与 curl

- 鼠标悬停在 JSON 树的任意一行上，会出现**复制**小按钮，复制该节点的值：字符串不带引号，对象或数组（即使已折叠）为格式化后的 JSON。
- **复制**会把整个请求或响应（含请求头）以 JSON 复制；**下载**把完整记录保存为 `llm-wire-trace-<id>.json`。
- **复制 curl** 会复制一条可直接运行、对 shell 安全的 `curl` 命令。由于存储的凭据已脱敏，凭据请求头会重新构造：
  - 若 DSH 的环境中设置了 `DSH_CURL_KEY`，就用它；否则对 `api.deepseek.com` / `api.anthropic.com`，使用该提供方自己的凭据（`DEEPSEEK_API_KEY` / `ANTHROPIC_API_KEY`）。密钥会直接写进命令——也就是说它此时就在你的剪贴板里。
  - 如果都找不到，命令会引用 `"$DSH_CURL_KEY"`，只需在 shell 里 `export DSH_CURL_KEY=...` 一次，之后复制的每条命令都能直接运行。

  请求头原有的格式（`Bearer <密钥>` 或裸密钥）会保留，复制后标签页会告诉你属于哪种情况。

### 轮次与步骤坐标

线路上几乎不带这些信息，所以本插件通过观察 harness 的两个通道把它们附加上去：

- **session、提供方、模型和用途**来自包裹每次模型调用的 `llm/stream` 事件，并绑定到该调用自己的异步上下文——并发调用之间互不混淆，哪怕同一 session 里同时跑着一个后台标题请求。
- **轮次与步骤**来自 `session/event`：调用开始时处于打开状态的那个 step，就是它所属的 step。
- 后台调用（`session-title`、`compaction`）不分配轮次和步骤。没有经过 harness 模型接口的调用会标记为无归属（若有 session，则取自 `x-deepseek-harness-session-id` 请求头）——绝不靠猜。
- 需要 `sessions` 与 `llm` 服务。没有它们时抓包照常工作，只是没有坐标。

## 持久化

记录会保存到磁盘，重启后依然存在；标签页把实时记录和已保存的记录合并成一个列表展示。设计与文件格式详见 [`docs/persistence.zh.md`](docs/persistence.zh.md)。

- **位置**：`traceDir`，默认为 `$DSH_HOME/llm-wire-trace/records`（取不到时为 `~/.dsh/llm-wire-trace/records`）。
- **格式**：紧凑的、只追加写入的段文件——`<start-ms>-<random>.dat` 存放 brotli 压缩后的记录，每个段另有一个小的 `.idx` JSONL 索引。这些文件不是给人直接打开看的，请在 Wire Trace 标签页里浏览。
- **占用小**：同一段对话里连续的请求几乎都在重复整段历史，所以每个请求体都存成相对同一 session 上一次请求的增量（公共前缀与后缀），再加以压缩。在真实流量上实测，一个 1.6 MB 的请求通常只占 3–30 KB。请求体仍能逐字节还原（无损），curl 重放和合并后的 SSE 视图都保持精确。
- **保留策略**：按磁盘预算 `maxDiskMB` 控制（默认 1024，即 1 GB）。超出后，最旧的段文件整个删除。按常见用量，这能存下几万次调用，而以前只有 300 条。
- **不保存的内容**：既没有请求体、也不是在模型调用内部发出的请求，例如周期性的 `GET /models` 轮询（它们以前会把真正的调用挤出旧的 300 条上限）。它们在重启前仍会实时显示在标签页里。
- **读取快**：启动时会把全部已保存记录的索引（仅元数据）加载进内存，因此列表、session 过滤和计数都不需要扫描磁盘；打开一条记录时，只读取并解压这一条。
- **内存**：内存里只保留进行中的调用和最近尚未落盘的记录（最多 100 条）；记录一旦安全写入磁盘，就从内存中移除。
- **清除**：标签页的**清空**按钮删除当前 session 的记录（相关段文件会被重写，去掉这些记录）；管理面板上的**清除全部历史记录**删除全部记录。
- **升级**：首次启动时，旧版本留下的记录（trace 目录里原有的 `*.json` 文件）会自动导入新格式，旧文件随后删除。
- **多个 DSH 进程**共用同一个 `$DSH_HOME` 是安全的：每个进程写各自的段文件。
- **`persist: false`** 时所有记录只保存在内存中（最近 100 条），不写入磁盘。

## 配置

| 配置项 | 默认值 | 含义 |
|---|---|---|
| `persist` | `true` | 是否把记录保存到磁盘。设为 `false` 时只在内存中保留最近 100 条。 |
| `maxDiskMB` | `1024` | 磁盘预算，单位 MB（最小 16）。超出后删除最旧的段文件。 |
| `traceDir` | `$DSH_HOME/llm-wire-trace/records` | 存储目录（取不到时为 `~/.dsh/llm-wire-trace/records`）。 |

可以在 DSH 的插件页（本插件的[管理面板](#插件管理面板)）中修改，也可以在 profile 的 `cordis.patch.yml` 中、本插件那一行的 `config:` 块里修改：

```yaml
- insert:
    - id: llm-wire-trace
      name: dsh-llm-trace-plugin
      config:
        maxDiskMB: 4096
```

旧版本的配置项（`maxRecords`、`maxBodyChars`、`maxPersistedRecords`、`historyPageLimit`、`prettyBodyLimit`）会被忽略，并在下次从管理面板保存设置时移除。每个请求体或响应体的捕获上限固定为 8,000,000 个字符（足以容纳 1M token 的上下文），不再可配置。

### 插件管理面板

在 DSH 的插件页（设置 → 插件 → `dsh-llm-trace-plugin`）中，本插件的面板显示：

- **存储用量**：已保存的记录数、已用磁盘空间与预算的对比（附一个小的用量条），以及最早一条记录的时间。
- **清除全部历史记录**：删除所有 session 的记录，包括内存和磁盘上的。
- **三项设置**，预填当前生效的值。修改会写回 profile，无需重启即可生效。
- **抓包缺口提示**：当某个提供方的模型调用没有任何请求被捕获时显示——见[已知限制](#已知限制)。

如果 host 没有提供写入插件配置的服务，设置项会以只读方式显示。如果面板提示当前显示的是默认值，说明正在运行的 host 仍是本插件的旧构建——请重启 `dsh web`。

## 隐私

- **请求体与响应体完整保存。** 你的 prompt、代码以及上下文中的任何文件内容，都会按捕获时的原样保存在 `traceDir` 下——经过压缩，但没有加密。对本地调试工具来说这是刻意的选择；如果介意，可以设置 `persist: false`，或使用**清空**。
- **凭据类请求头会被脱敏**，在存储或展示之前处理：`authorization` 和 `proxy-authorization` 变为 `Bearer ***redacted***`；`x-api-key`、`api-key`、`x-goog-api-key`、`x-dsh-auth-token`、`cookie` 和 `set-cookie` 变为 `***redacted***`。其他请求头不做任何改动。
- **URL 中的凭据类查询参数**（`key`、`api_key`、`access_token`、`token`、`secret`、`signature` 等——见 [`src/host/constants.ts`](src/host/constants.ts) 中的 `REDACTED_QUERY_PARAMS`）以同样方式脱敏，不区分大小写。
- 清空接口只接受同源的 `POST` 请求，因此其他网页无法清空你的历史记录。

## 已知限制

抓包只能看到经过被包装的 `globalThis.fetch` 的请求。内置适配器（`dsh-llm-deepseek`、`dsh-llm-pi-ai`）在发请求时才去取 `fetch`，因此总能被捕获。但如果某个提供方属于下面任一情况，它就是不可见的——没有记录，也没有报错：

1. **使用自带的 HTTP 客户端**，例如打包进来的 `undici` 实例，而不是全局 `fetch`；
2. **在模块被 import 时拷走 `globalThis.fetch`**，再把这份拷贝交给自家 SDK——`@jiesou/dsh-opencode-zen-free-provider` 就是这么做的。如果拷贝发生在本插件装好包装函数之前，它的调用就一条都看不到。**解决办法：在 `dsh.profile.bundles` 中把本插件排在这类提供方之前**（位于 profile 的 `package.json`，例如 `$DSH_HOME/profiles/web/package.json`），然后重启 DSH。安装其他插件后请再检查一次：DSH 的插件管理器会把新 bundle 追加到列表末尾；
3. **与其他会替换 `globalThis.fetch` 或全局 `undici` dispatcher 的东西同时运行。** 谁最后打补丁谁生效，所以不要把本插件和另一个给 fetch 打补丁的插件一起用。

**如何察觉**：插件会按提供方统计「没有捕获到任何请求的模型调用」。一旦出现，管理面板会显示抓包缺口提示，host 会为每个提供方打印一次警告，`GET /llm-wire-trace/stats` 也会在 `coverage` 下报告（`untracedCalls`）。这些计数只覆盖当前进程。

请把本插件当作调试用 profile 的一部分，并留意同一 profile 中还有什么也在动 `fetch`。

## 开发

```sh
pnpm install
pnpm run build       # tsc -> dist/host/**，esbuild -> dist/client.js
pnpm run typecheck   # host + client，仅类型检查、不产出文件
pnpm run test        # 运行 test/ 下的 node:test 测试
pnpm run lint        # 对 src/ 与 test/ 运行 oxlint
pnpm run verify      # build + typecheck + test + lint——完整的自检
```

需要 **Node >= 22.6**，使用 TypeScript 7 构建。`dist/` 是被 gitignore 的构建产物（只有 npm 包自带一份），因此每次改动源码后都要运行 `pnpm run build`，并重启 `dsh web` 才能加载。

- [`docs/architecture.zh.md`](docs/architecture.zh.md)——模块结构、数据流与设计取舍。
- [`docs/plugin-development.zh.md`](docs/plugin-development.zh.md)——本插件如何使用 DSH/Cordis 的服务、事件与 Slot。
- [`AGENTS.md`](AGENTS.md)（英文）——每次改动都必须遵守的验证流程、模块边界与硬性约束。

## 许可证

[MIT](LICENSE)
