# AGENTS.md

[English](AGENTS.md) | 中文

本文件面向在这个仓库里做改动的 AI agent（或人类贡献者）。它规定了每次改动必须走完的自验证流程、代码库已经依赖的模块边界，以及保护本项目既有设计取舍的硬性约束。改动 `src/` 下的结构前请先看 [`docs/architecture.zh.md`](docs/architecture.zh.md)；改动任何涉及 Cordis/DSH 扩展点的地方前请先看 [`docs/plugin-development.zh.md`](docs/plugin-development.zh.md)。

## 命令

```sh
pnpm install
pnpm run build       # tsc -> dist/host/**，esbuild -> dist/client.js
pnpm run typecheck    # host + client，仅类型检查不产出文件
pnpm run test         # tsc -> .test-build，node --test
pnpm run verify        # 依次跑 build + typecheck + test —— 完整的自验证
pnpm run clean          # 删除 dist/ 与 .test-build/
```

## 每次改动都要走完完整的自验证流程

只要改动涉及 `src/`，就没有"部分检查"这种捷径。在认为一次改动完成之前：

1. **`pnpm run verify`**（build + typecheck + test）必须全部通过，零错误、零失败用例。
2. 如果改动涉及 `src/host/**`、`src/shared/**`，或纯逻辑的 client 模块（`src/client/{constants,format,json-model,sse}.ts`、`src/client/sse-merge/**`）：必须在**同一次改动里**新增/更新 `test/` 下对应的文件——见下方"纯逻辑必须有测试覆盖"一节。不允许把逻辑改动和测试改动拆成两步分别提交。
3. 如果改动涉及 `src/client/sse-merge/**`（新增或修改某个 provider 格式的适配器）：还要额外用至少一条**真实**抓包记录做冒烟测试，而不是只靠合成数据。连上一个正在运行的 `dsh web`，从 `/llm-wire-trace/list` 和 `/llm-wire-trace/get` 抓一条真实记录，把它的 `response.bodyText` 直接喂给编译后的 `dist` 模块（`node -e "import('./dist/...').then(...)"`）。合成测试数据是刻意精简过的，已经漏过真实 provider 流量才会暴露的字段组合——具体案例见 `test/client/sse-merge/index.test.ts` 里的那条回归测试（一个 `message` item 自己的 `id` 被误判成 tool-call id 的那次真实 bug）。
4. 如果改动改变了 README 里描述的任何行为：必须在同一次改动里**同时**更新 `README.md` 和 `README.zh.md`，然后刷新 `README.i18n.yaml`：
   ```sh
   git hash-object README.md README.zh.md   # 把这两个哈希粘贴进 README.i18n.yaml
   ```
5. 如果改动调整了某个模块的职责或模块间边界：更新 `docs/architecture.md` 和 `docs/architecture.zh.md`。
6. 如果改动调整了本插件对某个 Cordis/DSH 扩展点的用法（新增服务依赖、新增事件、新增 Slot）：更新 `docs/plugin-development.md` 和 `docs/plugin-development.zh.md`。

只改 `docs/`、`AGENTS.md` 或注释的改动，最多跑 `pnpm run typecheck` 就够了——`pnpm run verify` 是给任何改变 `src/` 行为的改动准备的。

## 模块边界（完整解释见 `docs/architecture.zh.md`）

- **框架胶水代码每个半边只留一个文件**：`src/host/index.ts`（Cordis：`ctx.effect`、`ctx.on`、`ctx.get`）和 `src/client/entry.ts`（`window.__ModuleLoader__`、Cordis Slot）。其他任何模块都必须保持纯 TypeScript，不依赖 Cordis/`window`——这正是它们能被直接单元测试的原因。给其他任何模块新增 Cordis 或 `window.__ModuleLoader__` 引用都是一种倒退；应该把新能力抽到 `index.ts`/`entry.ts` 里，再从那里调用纯模块。
- **新的 SSE provider 格式要有自己的文件**，放在 `src/client/sse-merge/` 下，并注册进 `index.ts` 的 `ADAPTER_FACTORIES` 数组。不要往已有的适配器文件或 `index.ts` 本身里加 provider 专属的分支判断。
- **`src/host/persistence/` 保持三分**：`naming.ts`（文件名生成，不涉及 I/O）、`codec.ts`（记录 ⇄ 磁盘 JSON 互转，不涉及 I/O）、`archive.ts`（真正的文件 I/O，建立在前两者之上）。改动命名或编解码逻辑不应该需要动 `archive.ts`，反过来也一样。
- **Host 端不 import `@deepseek-ai/cordis`。** 它在 `src/host/index.ts` 里声明了自己的最小 `PluginContext` 结构类型（见该接口上方的注释）。不要为了"修正"这一点而加上真实的 import。
- **`src/shared/record-shape.ts` 是仅类型模块。** 它绝不能新增任何运行时导出——client bundle 只用 `import type` 引入它，任何运行时代码都会悄悄拖大 `dist/client.js`。

## 纯逻辑必须有测试覆盖

`docs/architecture.zh.md` 里列为可测试的每个模块（`src/host/**`、`src/shared/**` 全部，以及不含 DOM 的 client 模块：`constants.ts`、`format.ts`、`json-model.ts`、`sse.ts`、`sse-merge/**`）在 `test/` 下都有对应文件，路径与 `src/` 一一对应。往这些目录里新增文件，就要在同一次改动里新增它的测试文件；给已有文件新增一个导出函数，就要往已有测试文件里补测试用例。

**刻意排除在单元测试之外的部分**——不要为了凑覆盖率而引入 jsdom 或任何其他 DOM 模拟依赖；这是深思熟虑的取舍，不是遗漏：

- `src/host/index.ts`、`src/client/entry.ts` —— 纯 Cordis/`ModuleLoader` 胶水；靠 `pnpm run typecheck` 和 `pnpm run build` 成功来验证，而不是靠模拟一整个 Cordis `Context`。
- `src/client/api-client.ts`、`src/client/styles.ts`、`src/client/json-view.ts`、`src/client/wire-trace-view.ts` —— 依赖真实 DOM/React。用本项目开发历史中已经用过的"伪 React + 伪 `window.__ModuleLoader__` + 真实编译产物 `dist/client.js`"模式手工验证：用普通 JS 搭一个带 `useState`/`useEffect` 等方法的最小 `ReactLike` 对象，拿到 factory 的导出，用一个伪造的 `ctx` 调用 `apply(ctx)`。汇报改动时说明具体做了哪些验证步骤。

## 硬性约束（不要撤销这些经过深思熟虑的决定）

- **npm 是唯一"免费"拿到构建产物的安装路径。** `prepublishOnly`（`pnpm run clean && pnpm run build`）会在发布者本机上作为 `npm publish`/`pnpm publish` 流程的一部分运行，所以 registry 上的 tarball 永远带着与发布时源码完全对应的最新 `dist/`。**不要**为了把这个能力延伸到 git-spec/`link:` 安装而加 `prepare` 脚本：pnpm ≥10 要求 git 依赖的 `prepare` 脚本必须经过明确的 `allowBuilds` 批准才能运行，这正好会重新引入本项目一直在避免的"允许这个包在你安装的这一刻在你机器上跑任意代码"的提示。git checkout 或本地 `link:` 安装拿到的只有源码，必须自己跑一次 `pnpm run build`——具体步骤见 README 的"Install"一节里给用户的说明。
- **`dist/` 与 `.test-build/` 是 gitignore 掉的构建产物，不是仓库内容。** 绝不要提交它们，也绝不要把它们从 `.gitignore` 里移除——用 `pnpm run build` 重新生成即可（或者让 `prepublishOnly` 在发布时自动重新生成 `dist/`）。一份提交进版本库、却过期的 `dist/` 会在有人忘记先构建就提交时悄悄和 `src/` 脱节；不追踪它就彻底消除了这种失效模式。
- **`README.md` 和 `README.zh.md` 是强制同步的一对。** 绝不允许只改一侧不改另一侧，也不允许让 `README.i18n.yaml` 记录的哈希过期——那里的不匹配意味着有翻译缺口在评审时被漏掉了。
- **`src/host/persistence/` 里的 body 必须逐字存储。** 不要新增任何在请求/响应体落盘前对其做摘要、脱敏（超出 `authorization` 之外）或其他改写的逻辑；这个保证（见主 README 的"Persistence"一节）正是 curl 重放功能和合并后 SSE 视图值得信赖的前提。

## 编辑本文件

`AGENTS.md` 和 `AGENTS.zh.md` 和两份 README 一样是双语一对——要一起改。让本文件只聚焦于 agent 需要用来判断"改动该放哪"和"该怎么验证"的内容；任何解释"为什么这么设计"的内容都应该挪到 `docs/architecture.md` 或对应模块自己的文档注释里，在这里链接过去，而不是重复一遍。
