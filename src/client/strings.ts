/**
 * Every user-visible string in the Wire Trace tab, in one place.
 *
 * UI text used to sit inline across `wire-trace-view.ts`, `format.ts`, and
 * `json-view.ts`, which made the full wording of the tab impossible to review
 * without reading three files, and made a tone or terminology change a
 * scattered edit. Collecting it here also makes the interpolating helpers
 * testable, which they were not while they were string concatenation inside
 * `React.createElement` calls.
 *
 * This is deliberately NOT an i18n framework: there is one locale, and the
 * table is a plain object. It is the shape a future locale switch would need,
 * without paying for one now.
 *
 * @module dsh-llm-trace-plugin/client/strings
 */

/** Fixed labels and messages, grouped by where they appear. */
export const UI = {
  toolbar: {
    autoOn: '自动刷新',
    autoOff: '已暂停',
    autoOnTitle: '每 3 秒自动刷新（只读内存中的实时记录，不扫描磁盘）。点击暂停。',
    autoOffTitle: '已暂停刷新。点击恢复并立即刷新一次。',
    scopeSession: '当前 Session',
    scopeAll: '全部 Session',
    scopeUnavailableTitle: '拿不到当前 session id，只能显示全部记录。',
    scopeFilteringTitle: '当前只显示本 session 的 provider 调用。点击查看全部记录（含其他 session 和无 session 标记的调用）。',
    scopeAllTitle: '当前显示全部记录。点击只看本 session。',
    clear: '清空',
    clearTitle: '清空全部记录（不区分 session），磁盘上的历史记录也会一并删除。',
    metaFilteredTitle: '本 session 命中数 / 全部记录数（含磁盘）',
    metaAllTitle: '已加载 / 全部记录数（含磁盘）',
    /** Suffix on the counter line when background auxiliary calls are present. */
    auxiliarySuffix: ' 辅助',
  },
  tabs: {
    request: 'Request',
    response: 'Response',
    sseMerged: '优化展示',
    sseRaw: '原始 SSE',
    sseMergedTitle: '当前把分散的 delta 增量合并成完整内容，仍按 JSON 树展示。点击查看线路上的原始 SSE 文本。',
    sseRawTitle: '当前显示线路上的原始 SSE 文本（未合并）。点击切回合并后的完整内容。',
    collapse: '−',
    collapseTitle: '整体折叠一层',
    expand: '+',
    expandTitle: '整体展开一层',
    copy: '复制',
    download: '下载',
    curl: '复制 curl',
    curlBusy: '生成中…',
    curlTitle: '生成一条可以直接在命令行里跑的 curl 命令并复制到剪贴板。authorization 会尝试补上真实密钥，补不到就留占位符。',
  },
  empty: {
    filtered: '本 session 尚未捕获到 provider 调用。发一条消息后这里会出现记录（只记录带 deepseek-harness user-agent 的请求）。',
    all: '尚未捕获到 provider 调用。发一条消息后这里会出现记录（只记录带 deepseek-harness user-agent 的请求）。',
    noSelection: '在左侧选择一条记录查看完整请求/响应。',
    responsePending: '响应尚未到达（连接失败或仍在等待）。',
  },
  notice: {
    historyLoading: '正在后台载入磁盘历史记录…',
    autoFellBack: '本 session 没有可归属的记录（这些调用没有经过 ctx.llm，例如插件重载前就已经发出的请求），已自动显示全部记录。',
    truncatedHistory: '磁盘上还有更早的记录未被扫描（单次查询有读取上限）。',
    notJson: '这段内容不是 JSON，按原文显示。',
  },
  group: {
    auxiliary: '后台辅助调用',
    auxiliaryMeta: '不属于任何 turn',
    unattributed: '无归属调用',
    unattributedMeta: '未经过 ctx.llm',
  },
  coord: {
    purpose: '用途',
    purposeTitle: '后台辅助调用，不属于任何一次对话 turn。',
    turn: 'Turn',
    turnTitle: '第几轮对话。',
    step: 'Step',
    stepTitle: '一个 step = 一次模型调用。',
    attribution: '归属',
    provider: 'Provider',
    providerTitle: '解析到的 provider 路由。',
    session: 'Session',
    none: '—',
  },
  badge: {
    unattributed: '无归属',
    unattributedNoLlm: '这次请求没有经过 ctx.llm，插件无法确定它属于哪一轮对话。',
    unattributedOutsideTurn: '这次调用发生在任何 turn 之外。',
  },
  session: {
    none: '无 session',
    current: '本 session',
    noneTitle: '该请求在线路上没有携带 session 标记。',
  },
  purpose: {
    sessionTitle: '标题生成',
    compaction: '上下文压缩',
  },
  json: {
    copyNode: '复制该节点',
    collapseBlock: '点击收起',
  },
  curl: {
    copiedWithKey: '已复制，含解析到的真实密钥——它现在在你的剪贴板里，小心历史记录/共享屏幕。',
  },
} as const

/** `session <short id>` label for a row belonging to another session. */
export function foreignSessionLabel(shortId: string): string {
  return 'session ' + shortId
}

/** Tooltip naming the exact session a row belongs to. */
export function sessionTitle(sessionId: string): string {
  return 'session ' + sessionId
}

/** Tooltip carrying the full session id behind a shortened label. */
export function fullSessionIdTitle(sessionId: string): string {
  return '完整 session id：' + sessionId
}

/** Turn group header, e.g. `第 3 轮`. */
export function turnGroupLabel(turn: number): string {
  return '第 ' + turn + ' 轮'
}

/** Turn group meta line, e.g. `4 次调用 · 3 step`. */
export function turnGroupMeta(calls: number, steps: number): string {
  return calls + ' 次调用' + (steps > 0 ? ' · ' + steps + ' step' : '')
}

/** Tooltip for a background auxiliary call's badge. */
export function auxiliaryBadgeTitle(label: string): string {
  return '后台辅助调用（' + label + '），不属于任何一次对话 turn，因此没有 step 坐标。'
}

/** Tooltip for a `T<turn>·S<step>` badge. */
export function stepBadgeTitle(turn: number, step: number): string {
  return '第 ' + turn + ' 轮对话的第 ' + step + ' 步（一个 step = 一次模型调用）。'
}

/** Tooltip for a turn-only badge (a call landing between two steps). */
export function turnOnlyBadgeTitle(turn: number): string {
  return '第 ' + turn + ' 轮对话，调用发生在两个 step 之间。'
}

/**
 * Explains a body shown as raw text because it was cut at the character cap.
 * @param totalChars - the body's original length.
 * @param keptChars - how much survived the cap.
 */
export function truncatedBodyNotice(totalChars: string, keptChars: string): string {
  return '原始内容共 ' + totalChars + ' 个字符，超出上限，只保留了前 ' + keptChars + ' 个字符。'
    + '被截断的 JSON 无法解析，因此只能按原文显示；调高 maxBodyChars 可以保留更多。'
}

/** Notes how many unattributed records the session filter is hiding. */
export function hiddenUnattributedNotice(count: string): string {
  return '另有 ' + count + ' 条无归属记录（没有经过 ctx.llm 的请求），点击「全部 Session」查看。'
}

/** Notes that the JSON tree stopped emitting rows. */
export function jsonTruncatedNotice(rows: string): string {
  return '内容过多，已截断到 ' + rows + ' 行。'
}

/** Tells the reader which env var the copied curl command expects. */
export function curlCopiedWithEnvRef(envName: string): string {
  return '已复制，authorization 引用了 $' + envName + '；先 export ' + envName + '=你的密钥，再运行就不用改命令了。'
}

/** Reports a failure to build the curl command. */
export function curlFailed(message: string): string {
  return '生成失败：' + message
}

/** Depth stepper readout, e.g. `深度 2/5`. */
export function depthLabel(depth: number, contentDepth: number): string {
  return '深度 ' + depth + '/' + contentDepth
}
