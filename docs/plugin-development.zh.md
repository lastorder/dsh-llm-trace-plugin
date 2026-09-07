# DSH 插件开发：结合本仓库代码讲解

[English](plugin-development.md) | 中文

这是 [主 README](../README.zh.md) 的配套文档：主 README 讲的是"这个插件做了什么"，这篇讲的是"DSH/Cordis 插件是怎么开发的"，用本仓库的实际代码作为示例。内容有意保持简短——想看完整的概念讲解，请跟随文中链接的官方文档。

**主要参考资料**（下面没覆盖到的内容，先去这里找）：

- [DeepSeek Harness 仓库](https://github.com/deepseek-ai/deepseek-harness) —— 框架本身的权威来源。
- [Your first Harness plugin](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/) —— 写出第一个可用插件最短的路径。
- [Package and install a plugin](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish) —— bundle/profile 机制，本仓库的 `package.json` 与 `cordis.patch.yml` 遵循的就是这一套。
- [Services and dependencies](https://deepseek-harness.github.io/deepseek-harness/en/develop/framework/service) / [Event system](https://deepseek-harness.github.io/deepseek-harness/en/develop/framework/events) —— 本插件用到的两个扩展点（`ctx.on('llm/stream', ...)`、`ctx.on('session/event', ...)`）。
- [Cordis tutorial](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/index.md) —— Cordis 本身，Harness 底层的插件运行时，从零手把手教学。

## 1. 插件即 bundle：`package.json` + `cordis.patch.yml`

按照 [Package and install a plugin](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish) 的说法，一个可安装的插件是一个 npm 包（即 **bundle**），其 manifest 声明 `dsh.bundle.patch`，指向一个 YAML 文件，往组合配置里插入一行或多行：

```jsonc
// package.json（本仓库）
{
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-ui-conversation"]
    }
  }
}
```

```yaml
# cordis.patch.yml（本仓库）
- insert:
    - id: llm-wire-trace
      name: dsh-llm-trace-plugin
      # config:
      #   maxRecords: 200
```

这里的 `name` 是**包名**——由 Node 的模块解析找到已安装的代码——而不是文件路径。用户用 `dsh plugin --profile <name> add dsh-llm-trace-plugin` 安装它（本地开发用 `link:.`，或者一个 git spec 也行）；每种支持的安装方式见 README 的 [安装](../README.zh.md#安装) 一节。

可选的 `dsh.client` 块用于告诉加载器这个包**还有**一个浏览器半边；见第 3 节。

## 2. Host 半边：插件即 `apply(ctx, config)`

每一个 Cordis 插件——无论动态定义还是文件形式——最起码都是一个导出 `name` 和 `apply` 的模块：

```ts
// src/host/index.ts（节选）
export const name = 'llm-trace-plugin'
export const inject = ['webServer']

export function apply(ctx: PluginContext, config?: PluginConfig): void {
  // ...
}
```

- **`inject`** 声明硬依赖。本插件需要 `webServer`（它要注册一个 HTTP 路由），所以 Cordis 会等这个服务就绪之后才调用 `apply`。详见 [Services and dependencies](https://deepseek-harness.github.io/deepseek-harness/en/develop/framework/service)。
- **可选服务**改用 `ctx.get(name)` 读取，缺失时优雅降级而不是阻塞加载。本插件的 turn/step 归属功能需要 `sessions` 和 `llm`，但没有它们也能正常工作：

  ```ts
  // src/host/index.ts
  if (ctx.get('sessions') !== undefined) {
    ctx.on('session/event', (session, event) => tracker.observe(String(session.id), event))
  }
  if (ctx.get('llm') !== undefined) {
    ctx.on('llm/stream', (options, next) => bindLlmStream(options, next, tracker))
  }
  ```

- **`ctx.effect(fn, label?)`** 注册一个带自动销毁器的副作用，插件停止或更新时会被干净地撤销。本插件用它同时管理 `fetch` 补丁和 HTTP 路由：

  ```ts
  // src/host/index.ts
  ctx.effect(() => installFetchPatch((real) => store.wrapFetch(real)), 'llm-wire-trace: fetch patch')
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: routePrefix, handler: ... }))
  ```

本仓库还额外定义了自己的 `PluginContext` 类型（真实 `Context` 的一个最小结构子集），而不是直接 import `@deepseek-ai/cordis`——原因见 `src/host/index.ts` 里那个接口上方的注释：这样能让发布出去的包不带 host 运行时的类型依赖。如果你的插件是在 monorepo 内按官方教程开发的，直接 `import type { Context } from '@deepseek-ai/cordis'` 会更简单，也是推荐做法——除非你也有和本项目一样"独立发布、不依赖 monorepo"的约束。

## 3. Client 半边：Slot 与经典脚本打包格式

插件的浏览器一侧要注册进一个 **Slot**——外壳的 React 树渲染的一个具名扩展点。本插件往会话视图的标签环里注入了一个标签页：

```ts
// src/client/entry.ts（节选）
function apply(ctx) {
  ctx.slots.inject('conversation.view', () =>
    ctx.slots.register({ name: 'conversation.view', id: 'wire-trace', priority: 100, label: () => 'Wire Trace' }, WireTraceView),
  )
}
```

这一半边里有两点是*本插件自身*发布方式带来的约束，并非通用要求：

- **不用 JSX，不用 `import`。** 编译出来的 `dist/client.js` 是以经典脚本的方式通过 `window.__ModuleLoader__.load({ id, factory })` 加载的，所以每个元素都用 `React.createElement` 构建，`react` 本身也是通过 factory 的 `require` 拿到，而不是 ES import。如果你的插件是从 monorepo checkout 按官方教程开发的，通常不需要这样做——具体支持的方式请查阅 [DeepSeek Harness 仓库](https://github.com/deepseek-ai/deepseek-harness) 里当前的 client 插件编写指南。
- **Host↔Client 是 Package 私有的 JSON RPC**，不是共享内存：两个半边跑在不同进程里（Node vs. 浏览器），只能通过 `harness.handle(method, handler)`（host 端）/ `host.call(method, args)`（client 端）通信——或者，具体到本插件，是通过 `src/host/routes.ts` 注册的普通 HTTP 路由，由 `src/client/api-client.ts` 发起请求。无论走哪条通道，都只能传递可无损序列化的 JSON。

关于 Slot 注册的更多细节（精确的 prop 结构、其他扩展点、主题 token），应该去查看实际运行中的 Slot 树及其注册契约，而不是靠猜——在 DSH 会话里工作时，这正是 `cordis-plugin-development` Skill 及其 Inspect Provider 存在的意义。

## 3a. `locale` 服务：让标签页的语言跟随 DSH 自身的设置

DSH 自带一个第一方 client 插件 `@deepseek-ai/dsh-client-locale`，提供一个 `ctx.locale` 服务。本插件注入了它（`inject: ['slots', 'timer', 'locale']`），这样 Wire Trace 标签页的文案就会跟随 DSH 自身 Settings → General → Language 开关切换，而不是无论那个设置是什么都渲染同一种固定语言：

```ts
// src/client/entry.ts（节选）
const NS = 'llm-wire-trace'

function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'llm-wire-trace: locale dictionaries')
  const t = ctx.locale.bind(NS)
  // t 之后以普通参数的形式交给 client 半边的其余部分——
  // 没有其他模块直接接触 ctx.locale。
}
```

- **`ctx.locale.register(ns, { zh, en })`** 注册一个命名空间的两份词典——扁平的 `Record<key, string>` 映射，支持 `{name}` 风格的占位符（见 `src/client/strings.ts`）。带类型的调用点要求两种语言必须声明完全相同的 key 集合，因此漏翻译一条是编译期错误，而不是一个悄悄留白的标签。
- **`ctx.locale.bind(ns)`** 返回一个稳定的 `t(key, params?)` 函数，在调用时读取*当前生效*的 locale——绑定一次，全程复用同一个引用即可；语言切换后不需要重新绑定。
- **`ctx.locale.subscribe(fn)`** 在生效 locale 改变时触发。`wire-trace-view.ts` 用它来强制刷新已经挂载的标签页，让用户切换语言那一刻立即生效，而不是等到下次重新挂载才生效——这和 `@deepseek-ai/dsh-client-ui-conversation`（本插件的 `dsh.client.inject` 已经注入它）自身视图使用的是同一种模式。

其他每个 client 模块（`format.ts`、`json-view.ts`、`wire-trace-view.ts`）都以普通函数参数的形式接收 `t`，完全不知道 `ctx.locale` 的存在——只有 `entry.ts` 接触它，遵循的是本仓库已经用在 Slot 和 host 侧 Cordis 用法上的同一条"框架胶水代码只留在一个文件里"规则。`strings.ts`/`format.ts` 为什么能被拆成这样，见 [`architecture.zh.md`](architecture.zh.md#client-半边数据模型--适配器--视图)。

## 4. 本插件用到的事件：`llm/stream` 与 `session/event`

按照 [Event system](https://deepseek-harness.github.io/deepseek-harness/en/develop/framework/events) 的说法，一个事件既可以是普通广播，也可以是 **waterfall**——一条链，每个监听器包裹下一个，可以对流经的内容做变换。`llm/stream` 是包裹每次模型调用的 waterfall；本插件的监听器重新包裹了返回的流，在每次拉取时都绑定异步上下文身份：

```ts
// src/host/call-context.ts（节选）
export function bindLlmStream(options, next, tracker) {
  const bound = { sessionId: ..., turn: ..., step: ..., purpose: ..., provider: ..., model: ... }
  const inner = next()
  return (async function* boundStream() {
    const iterator = inner[Symbol.asyncIterator]()
    while (true) {
      const result = await callContext.run(bound, () => iterator.next())
      if (result.done) return
      yield result.value
    }
  })()
}
```

`src/host/call-context.ts` 里这个函数正上方的注释解释了*为什么*要在每次拉取时都重新进入上下文，而不是只在构造时包裹一次——如果你自己也要包裹一个流式 waterfall，这是个值得读一读的细节。

`session/event` 是一个普通广播，携带 `turn/start` / `step/start` / `step/end` / `turn/end`；`src/host/step-tracker.ts` 把这些事件折叠成"每个 session 当前打开的是哪个 turn/step"——一个很小、可以独立测试、完全不依赖 Cordis 的状态机。

## 5. 什么不是普通的 Cordis 用法：`fetch` 补丁

以上都是标准的扩展点用法。本插件唯一刻意"不寻常"的地方——在真实 Node 进程里补丁 `globalThis.fetch`——**恰恰是动态 Cordis 插件（通过 `cordis_define` 在运行时定义）完全做不到的事**：动态包运行在一个隔离的 `node:vm` realm 里，其 `globalThis` 不是进程真实的那个，`fetch` 按设计是一个会抛错的陷阱。这个功能之所以能成立，正是因为插件是作为**已安装的包**发布的，加载进真实进程里运行。完整的推理过程见 `src/host/fetch-patch.ts` 顶部的模块注释——这是本仓库唯一一处插件跳出框架自身扩展点范围的地方，那段注释精确解释了为什么这一步是安全的、以及为什么它必须是一个真实的包而不能是运行时定义的插件。

## 接下来看什么

- 搭建你自己的第一个插件：[Your first Harness plugin](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/)。
- 更深入了解服务、隔离与依赖行为：[Services and dependencies](https://deepseek-harness.github.io/deepseek-harness/en/develop/framework/service)。
- 更深入了解事件、waterfall 与短路机制：[Event system](https://deepseek-harness.github.io/deepseek-harness/en/develop/framework/events)。
- Cordis 本身，从一个空目录开始、不需要 API key：[Cordis tutorial](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/index.md)。
- [`architecture.zh.md`](architecture.zh.md) —— 本仓库自己的模块为什么这样拆分、数据如何在它们之间流动。
- 本仓库自己的逐模块结构与设计取舍：[主 README](../README.zh.md)，尤其是其中的"Repository layout"与"How it works"章节。
