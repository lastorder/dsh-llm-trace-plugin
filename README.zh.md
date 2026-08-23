# dsh-llm-trace-plugin

[English](README.md) | 中文

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件，用于捕获每一次 LLM 提供方调用的**原始 HTTP 请求与响应** —— 线路上真实的字节、提供方原生的字段名、未经处理的 SSE 帧 —— 并在 **Wire Trace** 会话标签页中浏览它们。

本插件工作在 *wire（线路）* 层。harness 层的追踪器观察的是 harness 构建出来的、已归一化的 `GenerateOptions` / `StreamChunk` 对象：与提供方无关，且带有 `sessionId` / `turn` / `step` 信息。而本插件完全没有 harness 层的概念 —— 它只看到真正离开进程的内容，以及真正返回的内容。

## 安装

直接从 git 安装：

```sh
dsh plugin --profile web add git+https://github.com/lastorder/dsh-llm-trace-plugin.git
```

用 fragment 指定分支或 tag：

```sh
dsh plugin --profile web add git+https://github.com/lastorder/dsh-llm-trace-plugin.git#main
dsh plugin --profile web add git+https://github.com/lastorder/dsh-llm-trace-plugin.git#v0.1.0
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

host 侧的插件行位于 [`cordis.patch.yml`](cordis.patch.yml)，支持三个可选配置项：

| 配置项 | 默认值 | 含义 |
|---|---|---|
| `maxRecords` | `200` | 环形缓冲区大小；只保留最近的 N 条记录。 |
| `maxBodyChars` | `200000` | 单个字段被截断前的字符上限。 |
| `routePrefix` | `/llm-wire-trace` | 本插件自身 HTTP 路由的前缀。 |

```yaml
- insert:
    - id: llm-wire-trace
      name: dsh-llm-trace-plugin
      config:
        maxRecords: 500
        maxBodyChars: 500000
```

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
  id, startedAt, endedAt, durationMs,
  status: 'ok' | 'http-error' | 'transport-error' | 'streaming',
  model,                          // 尽力而为，从解析后的请求体中读取
  request:  { method, url, headers /* 已脱敏 */, bodyText, bodyJson, bodyTruncated },
  response: { status, statusText, headers, contentType, bodyText, bodyJson, bodyTruncated } | null,
  error: { name, message } | null,
}
```

- `bodyText` 始终是原始字符串（逐字保留的 SSE 帧，或 JSON 错误体）。`bodyJson` 是为树视图做的尽力解析；SSE 响应体永远不会被作为整体去 JSON 解析（它是一个帧序列，而不是单个 JSON 值）。
- 没有 `sessionId` / `turn` / `step` —— 这一层没有这些概念。记录纯粹按时间排序。
- 响应体字段有字符上限，环形缓冲区也只保留最近的若干条；两者都可配置（见[配置](#配置)）。

## 查看器

一个可折叠、带语法着色的 JSON 树，配色取自产品自身的 shiki 调色板，因此能自动跟随明暗主题。包含 Request 和 Response 两个标签页，Response 标签页上还有一个 SSE 专用开关：`event-stream` 类型的响应体默认显示原始文本（帧序列通常就是你想直接阅读的形式），并可一键切换到树视图，用于少数需要深入查看某帧 JSON 载荷的场景。

> 应用内的按钮文案目前是中文。

### Request：解析后 / 原始 切换

Request 标签页默认显示解析后的 JSON 树。`解析后` / `原始 body` 按钮可切换到实际发送出去的请求体原文 —— 当请求体不是标准 JSON，或者你想逐字节查看而非透过树视图自己的 JSON 重新序列化时很有用。当请求体完全无法解析为 JSON 时，该开关会被强制锁定在原始模式并禁用。在 Request ↔ Response 之间切换会保留你对该条记录的选择；选择另一条记录则重置回解析后模式。

### 复制为 curl

`复制 curl` 按钮会向 host 请求一条依据该记录重建的、可直接运行的 `curl` 命令（`GET <routePrefix>/curl?id=`），并复制到剪贴板。每个参数都使用标准 POSIX 的 `'\''` 转义进行单引号包裹，因此该命令可以原样粘贴进 bash/zsh/sh 运行，即使请求体中包含引号、`$(...)` 或反引号也没问题。

存储下来的 `authorization` 头始终是脱敏占位符 —— 本插件从不在静态存储中保留真实密钥 —— 因此该请求头会在生成 curl 命令时重新构造，有两种方式：

- **解析到了真实值**，按以下顺序检查：
  1. 进程环境中的 `DSH_CURL_KEY` —— 一个由插件自身提供、与提供方无关的手动覆盖项，对**任何**请求都有效，无论它发往哪个提供方或主机。优先检查它，以保证显式覆盖总能生效。
  2. 专门针对 `https://api.deepseek.com`，采用与 `dsh-llm-deepseek` 适配器自身相同的密钥解析方式：先 `ctx.credentials`，再是环境变量 `DEEPSEEK_API_KEY`。

  无论哪种方式，密钥都会像其他请求头一样被单引号包裹后直接内联 —— 粘贴即可运行，无需再编辑。
- **两条路径都没找到**：该请求头会变成 `"authorization: Bearer $DSH_CURL_KEY"` —— 使用双引号，以便 shell 在运行时展开该变量；并且无论记录对应哪个提供方或主机，都始终使用这一个变量名。只需 `export DSH_CURL_KEY=...` 一次，复制出来的命令对**任何**记录都能原样运行；这正是该功能主要面向的场景。

每次复制后，客户端都会告诉你属于上述哪一种情况。内联真实密钥意味着**它现在就在你的剪贴板里**（粘贴后还可能进入 shell 历史）—— 在共享屏幕或粘贴到聊天工具前值得留意。`$DSH_CURL_KEY` 那种情况从设计上避免了这一点，因为真实密钥的值始终不会离开你 shell 的环境变量。

### jq 风格的格式化

Request 标签页的原始视图，以及 Response 标签页的非树视图（纯 JSON 与 SSE 两种情况），显示的是美化缩进后的 JSON，而不是线路上实际传输的内容 —— 请求体通常被适配器自己的 `JSON.stringify` 压缩过，这里会按 `jq .` 的方式重新缩进。对于 SSE，只有每一帧的 `data: {...}` 载荷会被重新格式化；帧结构（`event:` / `id:` / `retry:` 字段、注释行、空行分隔符，以及像 `data: [DONE]` 这样的非 JSON 标记）完全保持原样。完全无法解析为 JSON 的内容会逐字显示，因此畸形内容绝不会被悄悄"修正"成看起来合法的样子。

对 JSON 而言重新缩进是无损的，所以 `复制` 与屏幕上看到的是同一份美化文本；`下载` 仍然导出完整的记录，不受影响。

### 独立滚动：本插件需要修正的一个外壳 CSS 怪癖

左侧记录列表与右侧详情面板本应各自独立滚动，但外壳自身的 `ConversationRoot` CSS 会造成阻碍：对于任何已打开的非空白会话（`data-phase="active"` —— 对我们来说就是永远如此），它会把那个被称为 `viewArea` 的祖先元素设为 `flex:1 0 auto; min-height:auto`。这对 Chat 是有意为之 —— 它让消息列表可以超出可视区域生长，从而使*整个页面*滚动、并把输入框粘性固定在底部 —— 但同一条规则不可避免地会作用到每一个 `conversation.view` 条目，包括本插件，进而破坏双栏布局：由于没有一个有界高度可供溢出，根元素会撑到与内容等高，整个页面变成一起滚动。

`viewArea` 没有自己的稳定选择器（它的类名是构建时哈希的 CSS module 类），因此本插件的样式表转而通过结构来定位它，依据是框架自身始终会添加、并视为稳定的两个属性：每个 slot 的 `SlotOutlet` 包装元素都带有 `data-slot="<slot key>"`，这使得 `viewArea` 恰好就是 `div:has(>[data-slot="conversation.view"])`，与它自身的类名无关。再用 `:has(.wt-root)` 限定作用范围，就只会在*本*标签页正挂载于其中时才重新声明 `min-height:0; overflow:hidden; flex:1 1 0` —— Chat、Trajectory 以及任何其他标签页所对应的同一祖先元素都不受影响。

## 已知限制

本插件依赖于这样一个实现细节：当前所有的提供方适配器都调用裸的、未经 import 的 `fetch`。如果未来某个适配器改用自带的 HTTP 客户端（例如某个 SDK 内置了自己的 `undici` 实例），它对本补丁就是不可见的 —— 而且是静默不可见，不会报错。这是 fetch 补丁这一方案的固有局限，而非本插件的缺陷。

## 仓库结构

```
src/index.js       host 半边 —— fetch 补丁、记录存储与 HTTP 路由
src/client.js      浏览器半边 —— Wire Trace 标签页，手写的 bundle 格式
cordis.patch.yml   host 组合中的插件行（dsh.bundle.patch）
package.json       dsh.bundle 与 dsh.client 声明
```

没有构建步骤：两个半边都是纯 JavaScript，原样提供与加载。

## 许可证

[MIT](LICENSE)
