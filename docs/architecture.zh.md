# 架构：本项目的代码结构设计

[English](architecture.md) | 中文

本文档是 [`plugin-development.zh.md`](plugin-development.zh.md) 的补充：那篇讲的是本插件用到的 DSH/Cordis 机制，这篇讲*内部*设计——代码为什么这样拆分、模块之间数据怎么流动、每一层各自负责什么边界。阅读前建议先浏览一遍 [主 README](../README.zh.md)，了解插件*做了什么*。

## 两个进程的形态

一个带浏览器半边的 DSH 插件，本质上是两个一起发布、但永远不共享内存的程序：

```
┌─────────────────────────────┐      HTTP（仅 JSON）      ┌──────────────────────────────┐
│  src/host/  （Node 进程）    │ ◄───────────────────────► │  src/client/  （浏览器）      │
│  由 tsc 逐文件编译           │                            │  由 esbuild 打包成单个      │
│  → dist/host/**              │                            │  经典脚本 → dist/client.js │
└─────────────────────────────┘                            └──────────────────────────────┘
              │                                                             │
              └──────────────────────┬──────────────────────────────────────┘
                                      │ 仅类型（编译时被完全擦除）
                              ┌───────▼────────┐
                              │  src/shared/    │
                              │  record-shape.ts│
                              └────────────────┘
```

`src/shared/` 是两个半边唯一共同引用的东西，而且对客户端 bundle **零运行时体积贡献**——完全是 `import type`（`WireRecord`、`WireRecordSummary` 等），所以双方在记录字段命名上达成一致，却互相不依赖对方的代码。

## Host 半边：抓包 → 存储 → 对外服务

Host 一侧只有一件事要做——把原始 `fetch` 流量变成可查询的记录——拆成三层，每层都能独立测试：

```
fetch-patch.ts ──记录──► store.ts ──提供服务──► routes.ts
     ▲                      │                      ▲
     │                      ▼                      │
call-context.ts       persistence/（archive.ts、codec.ts、naming.ts）   config.ts
step-tracker.ts
     ▲                                              ▲
     │                                              │
index.ts（apply）把以上所有模块组装进 ctx.effect()/ctx.on()，并把 config.ts 的 schema 接入 Cordis 的激活流程
```

- **`fetch-patch.ts`** 是抓包层：只知道如何包裹一个 `fetch` 函数并产出一个 `WireRecord`，别的什么都不知道。它把 `push`/`finalize` 回调作为参数接收，而不是直接 import store——这样就能用一个伪造的 `fetch` 单独对它做单元测试，完全不需要真的 store。
- **`call-context.ts`** / **`step-tracker.ts`** 是*归属*层：回答"这次调用属于哪个 turn/session/purpose"，与 HTTP、存储完全无关。`step-tracker.ts` 尤其干净——零 Cordis、零 Node 依赖，就是一个基于 `Map` 的状态机，测试方式和任何普通 TypeScript 模块一样。
- **`config.ts`** 承载 `PluginConfig`（面向用户的形状）、它的运行时 `Config` schema（`@deepseek-ai/schemastery`，不依赖 Cordis），以及 `resolveEffectiveConfig`——唯一应用每个字段默认值的地方，因此 `index.ts` 的 `apply`、`config` 路由的 `GET`，以及这个文件自己的测试，对"当前生效的配置"达成一致。它独立于 `index.ts` 存在，原因与 `persistence/constants.ts` 一样：默认值的改动和 Cordis 接线的改动是两个不同的关注点，放在同一个文件里会让其中一个改动的测试意外跑到另一个改动的代码路径上。
- **`store.ts`** 是编排层：内存环与可选的持久化 `archive` 实时合并。它依赖 `fetch-patch.ts`（构造包裹后的 `fetch`）和 `persistence/`（持久化/恢复），但对 HTTP 一无所知。它还会把每条被 push 的记录的提供方/主机信息喂给 **`coverage.ts`**——一个小巧、无依赖的计数器，回答"自本进程启动以来，各提供方分别产生了多少次调用"这一问题，它是一个健康信号，不是记录本身的一部分，只读地经由 `stats()` 暴露出去。它存在的原因是：fetch 补丁的覆盖率只有在 `globalThis.fetch` 在整个进程生命周期内始终保持为生效引用时才可信；某个本该产生流量的提供方在这里显示为零，就是全局槽位被本补丁不知不觉之间悄悄换掉的可观测症状（参见 README 的"已知限制"一节）。`store.ts` 自己的 `clear()` 接受一个可选的 `sessionId`，把内存环与 archive 的清空都限定到一个 session——Wire Trace 标签页自己的「清空」按钮会传入它，插件管理页的「清除全部历史记录」按钮则不传。
- **`persistence/`** 自己又拆成三份，因为"存一条记录"、"给文件起名字"、"把记录重新组织成适合落盘的形状"是三个不同的关注点——在这次重构之前它们挤在一个 689 行的文件里：
  - `naming.ts` —— 把时间戳变成全局唯一、按时间可排序的文件名（不涉及 I/O）。
  - `codec.ts` —— 在内存记录形状与磁盘 JSON 形状之间互转（不涉及 I/O）。
  - `archive.ts` —— 真正的 `readdir`/`readFile`/`writeFile` 编排，建立在上面两者之上。它的 `clear(options?)` 与 `store.ts` 的 session 范围约定一致：不限定 session 的清空是纯文件名操作（不打开任何文件），而限定了 session 的清空必须先打开每个文件读取其 `sessionId`——采用与 `list()` 相同的"并发分批 + 批间让出事件循环"纪律，因此一次大范围的限定清空也不会卡住 web UI 共用的那个事件循环。
- **`routes.ts`** 是面向 HTTP 的层：只有它知道 `IncomingMessage`/`ServerResponse` 和 query string，调用 `store`/`curl.ts`/`config.ts`——但 store 完全不知道有 HTTP 服务器存在。这也是为什么 `createWireTraceStore` 可以脱离一个真正运行的 web 服务器直接被验证（本仓库开发过程中做过的冒烟测试就是这么跑的）。它的 `config` 路由（`GET`/`POST`）是本插件唯一会写自己持久化配置的地方：`POST` 把一份补丁合并到当前配置之上，用 `config.ts` 的 `Config` schema 校验结果，再通过 Cordis 的 `configEditor` 服务（如果 host 提供了的话）持久化——这样做为什么安全、在该服务缺席时会退化成什么样子，见 [`plugin-development.zh.md`](plugin-development.zh.md)。
- **`curl.ts`** 是一个自成一体的功能（把一条记录渲染成 `curl` 命令），只有 `routes.ts` 调用它；它完全不参与抓包或存储。
- **`index.ts`** 是唯一 import Cordis 概念（`ctx.effect`、`ctx.on`、`ctx.get`、`ctx.fiber`）的文件——其他所有 host 模块都是普通 TypeScript，"恰好对 Cordis 插件有用"，而不是"和 Cordis 耦合在一起"。正是这种分离，让开发这个插件时每一层都能用普通 Node 脚本验证，完全不需要跑起来一个真正的 DSH 进程。

## Client 半边：数据模型 → 适配器 → 视图

浏览器一侧遵循同样的"把纯计算和框架胶水代码分开"原则，拆成三份：

```
sse.ts（解析）──帧──► sse-merge/（重组）──合并后的 JSON──► wire-trace-view.ts ──渲染──► json-view.ts
                                                                  │
                    view-model.ts（列表/详情逻辑）、json-model.ts（展平）、
                    format.ts（标签）、strings.ts（文案）、api-client.ts（fetch）

plugin-manage-view.ts ──渲染（缓存统计、清除全部、每一项 Config 字段）──► plugins.bundle.config 这个 Slot
  （与 wire-trace-view.ts 共享 ViewContext/WireTraceReact 类型；复用同一份 api-client.ts 与 strings.ts）
```

- **`sse.ts`** 只知道 SSE 线路格式（`event:`/`data:`/空行分帧），从没听说过 OpenAI、Anthropic 或 Cordis。
- **`sse-merge/`** 是一个小型适配器注册表——它为什么存在，见 [`plugin-development.zh.md` 第 5 节](plugin-development.zh.md#5-什么不是普通的-cordis-用法fetch-补丁)；它产出什么，见主 README 的 ["Response：合并后的 SSE"](../README.zh.md#response合并后的-sse以及底下的原始线路文本) 一节。结构上，每个文件都是一个自成一体的状态机，实现同一个 `SseMergeAdapter<TResult>` 接口（`shared.ts`）：

  | 文件 | 识别 | 重组为 |
  |---|---|---|
  | `anthropic.ts` | `event: message_start` / `content_block_delta` / … | 非流式 `POST /v1/messages` 响应的形状 |
  | `openai-responses.ts` | `event: response.output_item.added` / `response.output_text.delta` / … | 非流式 `POST /v1/responses` 响应的形状 |
  | `openai-chat-completions.ts` | 带顶层 `choices` 数组的对象 | 非流式 `POST /v1/chat/completions` 响应的形状 |
  | `index.ts` | —— | 依次把每一帧交给以上各适配器尝试；没有适配器认领的帧进入 `unrecognized` |

  以后要支持第四种 provider 形状，只需要在这三个文件旁边新增一个文件，再把它的工厂函数注册进 `index.ts` 的 `ADAPTER_FACTORIES` 数组——模块里的其他任何地方都不用改。这正是拆分存在的原因：之前的单文件版本把"怎么识别这一帧"和"怎么渲染它"混在一起，导致新增一个 provider 意味着改一个不断膨胀的函数，而不是新增一个文件。
- **`json-model.ts`** 是 JSON 树展平算法（`flattenJq`、折叠/展开状态记录），不含 DOM、不含 React——正是它让 request 面板、合并后的 response 面板、原始帧面板都能走同一套可折叠树来渲染。
- **`format.ts`** 是纯展示层的字符串格式化（turn 徽标、session 标签、时间戳），无状态、无副作用。每个产出面向用户文案的函数都把当前 locale 的 `t(key, params?)` 作为显式参数接收，而不是直接 import 某个词典——这正是让它保持无框架依赖、可直接单元测试（测试传入一个小小的伪造 `t`）、同时又具备 locale 感知能力的原因。
- **`strings.ts`** 收纳了两份扁平的双语（`zh`/`en`）locale 词典——标签页中所有面向用户的文案，以及每一条需要插值的消息，都由同一个 key（`toolbar.clear`、`notice.truncatedBody` 等）寻址，用 `{name}` 风格的占位符。这正是 DSH 自身的 `@deepseek-ai/dsh-client-locale` 服务所期望的形状：`entry.ts` 通过 `ctx.locale.register` 把两份词典注册进本插件自己的命名空间，其他每个 client 模块都以参数形式接收绑定好的 `t`，而不是直接 import 这个文件的词典——因此标签页的语言会跟随 DSH 自身的语言设置，而不是永远渲染固定的一种语言。
- **`view-model.ts`** 是标签页背后的纯列表/详情逻辑：合并内存与历史这两条竞争读取路径（`mergeSummaryPages`）、判断何时必须放弃 session 过滤（`shouldFallBackToAllSessions`）、按 turn 分组（`groupRows`），以及决定每个页签渲染哪份 body（`selectRequestBody`/`selectResponseBody`/`describeBodyNotice`）。其中没有任何一处触碰 React、`window` 或 `document`。它之所以存在，是因为这部分逻辑是 client 半边里最微妙的 —— 那次合并正是防止一次迟到的轮询把已加载的历史记录抹掉的关键 —— 而当它还待在组件内部时，完全没有任何测试覆盖。
- **`api-client.ts`** 是本插件自身 `/llm-wire-trace/*` 路由的薄 `fetch` 封装（与 host 侧的 `routes.ts` 对应），外加两个无关的浏览器工具函数（`download`、`copy`）。
- **`json-view.ts`** 是唯一的展示型 React 组件，参数化在一个最小的 `ReactLike` 接口之上，而不是直接 import `react`——因为按 `plugin-development.zh.md` 里讲的经典脚本约束，`react` 只在运行时通过 factory 的 `require` 才存在，永远不会是静态 import。
- **`wire-trace-view.ts`** 是唯一持有状态（`React.useState`/`useEffect`）、把以上所有模块编排成标签页实际行为的文件——轮询、过滤、合并/原始切换。它是 `src/client/` 里体量最大的文件，这是有意为之：状态编排本来就不像纯计算那样能被干净拆解；凡是*能*被提取成纯逻辑的部分都已经提取出去了（进了 `view-model.ts`/`json-model.ts`/`format.ts`/`strings.ts`/`sse-merge/`），剩下留在这个文件里的，就只是那些真正关于"这个组件此刻该做什么"的部分。剩下的内容绝大多数是 `React.createElement` 树 —— 这也是为什么把逻辑提取出去之后，文件行数缩减得远不如受测面积增长得多。它的「清空」按钮限定在当前 session（`apiPost('clear', { sessionId })`）。
- **`plugin-manage-view.ts`** 是本插件在 DSH 自身插件页里的内容（`plugins.bundle.config` 这个 Slot，`entry.ts` 按包名注册）——本地缓存统计、一个页面级的「清除全部历史记录」按钮（`apiPost('clear', {})`，不带 `sessionId`），以及一份覆盖每个 `PluginConfig` 字段的表单，经由 `config` 路由读写。它复用 `wire-trace-view.ts` 的 `ViewContext`/`WireTraceReact` 类型以及 `api-client.ts`/`strings.ts`，而不是另起一份，但自己拥有独立的状态——两个 Slot（`conversation.view`、`plugins.bundle.config`）彼此无关，只是恰好同属这一个插件。它的 `CONFIG_FIELDS` 列表重复了一份 `config.ts` 的字段集合（与 `constants.ts` 里 `ROUTE`/`PACKAGE_NAME` 跨边界重复的原因相同），由一个同时 import 两侧的测试钉住。当 `config` 路由完全读不到时（最常见的原因是 host 进程还跑着这个插件更早的构建——更新插件之后没有重启 `dsh web`，host 端代码就不会热重载），面板会回退展示 `CONFIG_FIELD_DEFAULTS`——每一项的文档默认值，同样由那个测试对照 `config.ts` 的 `resolveEffectiveConfig` 钉住——而不是把这次读取失败呈现成一个读者什么都做不了的错误。
- **`entry.ts`** 是唯一接触 `window.__ModuleLoader__`、Cordis Slot 注册、或 `ctx.locale` 服务的文件——与 host 侧的 `index.ts` 是同一种"框架胶水代码只留在一个文件里"的模式。`strings.ts` 的 `zh`/`en` 词典就是在这里被注册并绑定成 `t` 函数，再以普通参数的形式交给其他每个 client 模块。

## 为什么是这个形状，从更普遍的角度看

上面每一处拆分背后都贯穿着两条规则，值得带到任何新插件里去，不论那个插件具体做什么：

1. **框架胶水代码每个半边只留一个文件**（`src/host/index.ts`、`src/client/entry.ts`）。其余每个模块都是普通 TypeScript，直接 import 进来调用函数就能测试——不需要 Cordis context、不需要 DOM、不需要跑起来一个 DSH 进程。正是这一点让本插件整个重写过程（见本仓库的开发历史）能够通过 `node -e "..."` 把真实抓到的记录直接灌进编译后的模块来验证，而不是只能靠点开一个真正运行的界面去检查。`test/` 让这一点从理论变成了具体事实：它逐文件对应同一条边界（`test/host/**` 对应 `src/host/**`，`test/client/**` 对应不含 DOM 的 `src/client/*.ts`），边界这一侧的每个模块都有一份真实的 `node:test` 用例在验证它——确切规则和刻意排除在外的模块见 [`AGENTS.md`](../AGENTS.md)（英文）。
2. **一个关注点一旦会强迫两件不相关的事情被迫一起改动，它就该有自己的文件。** `persistence/naming.ts` 和 `archive.ts` 的对比是最清楚的例子：以前文件名格式的改动和保留策略清理的改动要动同一个函数；拆开之后，改其中一个都不会让另一个的测试跑错断言。

## 接下来看什么

- [`plugin-development.zh.md`](plugin-development.zh.md) —— 同一份代码库里 DSH/Cordis 相关的那一侧（服务、事件、Slot，以及为什么 `fetch` 补丁必须是已安装的包）。
- [`AGENTS.md`](../AGENTS.md)（英文） —— 一次改动必须走完的自验证流程，以及它强制执行的模块边界/硬性约束。
- [主 README，"Repository layout"](../README.zh.md#仓库结构) —— 本文档图示所概括的、逐文件的平铺列表。
- [主 README，"How it works"](../README.zh.md#工作原理) —— 这些模块实现的运行时行为，与它们如何被拆分无关。
