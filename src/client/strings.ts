/**
 * Every user-visible string in the Wire Trace tab, in two languages.
 *
 * UI text used to sit inline across `wire-trace-view.ts`, `format.ts`, and
 * `json-view.ts`, which made the full wording of the tab impossible to review
 * without reading three files, and made a tone or terminology change a
 * scattered edit. Collecting it here also makes the interpolating helpers
 * testable, which they were not while they were string concatenation inside
 * `React.createElement` calls.
 *
 * This IS the shape DSH's own locale service expects: a flat
 * `Record<key, string>` dictionary per supported locale (`zh`/`en`), with
 * `{name}`-style placeholders for interpolated values, registered through
 * `ctx.locale.register(NS, { zh, en })` in `entry.ts` and read back through
 * `ctx.locale.bind(NS)`'s `t(key, params?)`. Both dictionaries are REQUIRED
 * to declare exactly the same key set — `entry.ts`'s typed registration call
 * makes a missing key in either language a compile error, and the test suite
 * checks the same property again at the data level so a later hand-edit to
 * either dictionary cannot silently drift them apart.
 *
 * Every key here is named the same way the old nested `UI` table addressed
 * it (`toolbar.autoOn`, `tabs.request`, …), joined with `.` — flat because
 * that is what the locale dictionary format requires, not because the
 * grouping stopped mattering; the grouping is preserved in the section
 * comments below.
 *
 * @module dsh-llm-trace-plugin/client/strings
 */

/** Flat locale dictionary: key to template string (`{name}` placeholders). */
export type LocaleDict = Record<string, string>

/** Chinese dictionary. Every key here must also exist in {@link en}, and vice versa. */
export const zh: LocaleDict = {
  // -- toolbar --
  'toolbar.autoOn': '自动刷新',
  'toolbar.autoOff': '已暂停',
  'toolbar.autoOnTitle': '每 3 秒自动刷新（只读内存中的实时记录，不扫描磁盘）。点击暂停。',
  'toolbar.autoOffTitle': '已暂停刷新。点击恢复并立即刷新一次。',
  'toolbar.scopeSession': '当前 Session',
  'toolbar.scopeAll': '全部 Session',
  'toolbar.scopeUnavailableTitle': '拿不到当前 session id，只能显示全部记录。',
  'toolbar.scopeFilteringTitle': '当前只显示本 session 的 provider 调用。点击查看全部记录（含其他 session 和无 session 标记的调用）。',
  'toolbar.scopeAllTitle': '当前显示全部记录。点击只看本 session。',
  'toolbar.clear': '清空',
  'toolbar.clearTitle': '清空全部记录（不区分 session），磁盘上的历史记录也会一并删除。',
  'toolbar.metaFilteredTitle': '本 session 命中数 / 全部记录数（含磁盘）',
  'toolbar.metaAllTitle': '已加载 / 全部记录数（含磁盘）',
  /** Suffix on the counter line when background auxiliary calls are present. */
  'toolbar.auxiliarySuffix': ' 辅助',
  // -- tabs --
  'tabs.request': 'Request',
  'tabs.response': 'Response',
  'tabs.sseShowRaw': '显示原始 SSE',
  'tabs.sseShowMerged': '显示合并结果',
  'tabs.sseShowRawTitle': '当前把分散的 delta 增量合并成完整内容，仍按 JSON 树展示。点击改为显示线路上的原始 SSE 文本。',
  'tabs.sseShowMergedTitle': '当前显示线路上的原始 SSE 文本（未合并）。点击改为显示合并、重组后的完整内容。',
  'tabs.collapse': '−',
  'tabs.collapseTitle': '整体折叠一层',
  'tabs.expand': '+',
  'tabs.expandTitle': '整体展开一层',
  'tabs.copy': '复制',
  'tabs.download': '下载',
  'tabs.curl': '复制 curl',
  'tabs.curlBusy': '生成中…',
  'tabs.curlTitle': '生成一条可以直接在命令行里跑的 curl 命令并复制到剪贴板。authorization 会尝试补上真实密钥，补不到就留占位符。',
  // -- empty --
  'empty.filtered': '本 session 尚未捕获到 provider 调用。发一条消息后这里会出现记录（只记录带 deepseek-harness user-agent 的请求）。',
  'empty.all': '尚未捕获到 provider 调用。发一条消息后这里会出现记录（只记录带 deepseek-harness user-agent 的请求）。',
  'empty.noSelection': '在左侧选择一条记录查看完整请求/响应。',
  'empty.responsePending': '响应尚未到达（连接失败或仍在等待）。',
  // -- notice --
  'notice.historyLoading': '正在后台载入磁盘历史记录…',
  'notice.autoFellBack': '本 session 没有可归属的记录（这些调用没有经过 ctx.llm，例如插件重载前就已经发出的请求），已自动显示全部记录。',
  'notice.truncatedHistory': '磁盘上还有更早的记录未被扫描（单次查询有读取上限）。',
  'notice.notJson': '这段内容不是 JSON，按原文显示。',
  // -- group --
  'group.auxiliary': '后台辅助调用',
  'group.auxiliaryMeta': '不属于任何 turn',
  'group.unattributed': '无归属调用',
  'group.unattributedMeta': '未经过 ctx.llm',
  // -- coord --
  'coord.purpose': '用途',
  'coord.purposeTitle': '后台辅助调用，不属于任何一次对话 turn。',
  'coord.turn': 'Turn',
  'coord.turnTitle': '第几轮对话。',
  'coord.step': 'Step',
  'coord.stepTitle': '一个 step = 一次模型调用。',
  'coord.attribution': '归属',
  'coord.provider': 'Provider',
  'coord.providerTitle': '解析到的 provider 路由。',
  'coord.session': 'Session',
  'coord.none': '—',
  // -- badge --
  'badge.unattributed': '无归属',
  'badge.unattributedNoLlm': '这次请求没有经过 ctx.llm，插件无法确定它属于哪一轮对话。',
  'badge.unattributedOutsideTurn': '这次调用发生在任何 turn 之外。',
  // -- session --
  'session.none': '无 session',
  'session.current': '本 session',
  'session.noneTitle': '该请求在线路上没有携带 session 标记。',
  // -- purpose --
  'purpose.sessionTitle': '标题生成',
  'purpose.compaction': '上下文压缩',
  // -- json --
  'json.copyNode': '复制该节点',
  'json.collapseBlock': '点击收起',
  // -- curl --
  'curl.copiedWithKey': '已复制，含解析到的真实密钥——它现在在你的剪贴板里，小心历史记录/共享屏幕。',
  // -- interpolated templates (formerly the standalone helper functions) --
  'session.foreignLabel': 'session {shortId}',
  'session.title': 'session {sessionId}',
  'session.fullIdTitle': '完整 session id：{sessionId}',
  'turn.groupLabel': '第 {turn} 轮',
  'turn.groupMetaWithSteps': '{calls} 次调用 · {steps} step',
  'turn.groupMetaNoSteps': '{calls} 次调用',
  'badge.auxiliaryTitle': '后台辅助调用（{label}），不属于任何一次对话 turn，因此没有 step 坐标。',
  'badge.stepTitle': '第 {turn} 轮对话的第 {step} 步（一个 step = 一次模型调用）。',
  'badge.turnOnlyTitle': '第 {turn} 轮对话，调用发生在两个 step 之间。',
  'notice.truncatedBody': '原始内容共 {totalChars} 个字符，超出上限，只保留了前 {keptChars} 个字符。被截断的 JSON 无法解析，因此只能按原文显示；调高 maxBodyChars 可以保留更多。',
  'notice.hiddenUnattributed': '另有 {count} 条无归属记录（没有经过 ctx.llm 的请求），点击「{scopeAll}」查看。',
  'json.truncatedNotice': '内容过多，已截断到 {rows} 行。',
  'curl.copiedWithEnvRef': '已复制，authorization 引用了 ${envName}；先 export {envName}=你的密钥，再运行就不用改命令了。',
  'curl.failed': '生成失败：{message}',
  'depth.label': '深度 {depth}/{contentDepth}',
}

/** English dictionary. Every key here must also exist in {@link zh}, and vice versa. */
export const en: LocaleDict = {
  // -- toolbar --
  'toolbar.autoOn': 'Auto-refresh',
  'toolbar.autoOff': 'Paused',
  'toolbar.autoOnTitle': 'Auto-refreshes every 3s (reads only the live in-memory ring, never scans disk). Click to pause.',
  'toolbar.autoOffTitle': 'Refresh is paused. Click to resume and refresh once immediately.',
  'toolbar.scopeSession': 'Current Session',
  'toolbar.scopeAll': 'All Sessions',
  'toolbar.scopeUnavailableTitle': 'No current session id available, so only the full list can be shown.',
  'toolbar.scopeFilteringTitle': 'Showing only this session\'s provider calls. Click to see every record (including other sessions and unattributed calls).',
  'toolbar.scopeAllTitle': 'Showing every record. Click to show only this session.',
  'toolbar.clear': 'Clear',
  'toolbar.clearTitle': 'Clear every record (regardless of session); persisted history on disk is deleted too.',
  'toolbar.metaFilteredTitle': 'Matches in this session / total records (including disk)',
  'toolbar.metaAllTitle': 'Loaded / total records (including disk)',
  'toolbar.auxiliarySuffix': ' aux',
  // -- tabs --
  'tabs.request': 'Request',
  'tabs.response': 'Response',
  'tabs.sseShowRaw': 'Show raw SSE',
  'tabs.sseShowMerged': 'Show merged view',
  'tabs.sseShowRawTitle': 'Scattered delta fragments are currently merged into complete content, shown as a JSON tree. Click to show the raw SSE text on the wire instead.',
  'tabs.sseShowMergedTitle': 'Currently showing the raw SSE text on the wire (unmerged). Click to show the merged, reassembled content instead.',
  'tabs.collapse': '−',
  'tabs.collapseTitle': 'Collapse one level everywhere',
  'tabs.expand': '+',
  'tabs.expandTitle': 'Expand one level everywhere',
  'tabs.copy': 'Copy',
  'tabs.download': 'Download',
  'tabs.curl': 'Copy as curl',
  'tabs.curlBusy': 'Generating…',
  'tabs.curlTitle': 'Generate a ready-to-run curl command and copy it to the clipboard. A real credential is inlined when resolvable, otherwise a placeholder is left.',
  // -- empty --
  'empty.filtered': 'No provider calls captured yet for this session. A record appears here once you send a message (only requests carrying the deepseek-harness user-agent are recorded).',
  'empty.all': 'No provider calls captured yet. A record appears here once you send a message (only requests carrying the deepseek-harness user-agent are recorded).',
  'empty.noSelection': 'Select a record on the left to see its full request/response.',
  'empty.responsePending': 'No response has arrived yet (the connection failed, or it is still waiting).',
  // -- notice --
  'notice.historyLoading': 'Loading on-disk history in the background…',
  'notice.autoFellBack': 'No attributable records exist for this session (these calls never went through ctx.llm — e.g. requests made before the plugin reloaded), so every record is now shown automatically.',
  'notice.truncatedHistory': 'Older records still exist on disk that were not scanned (one query has a read cap).',
  'notice.notJson': 'This content is not JSON, shown as raw text.',
  // -- group --
  'group.auxiliary': 'Background auxiliary calls',
  'group.auxiliaryMeta': 'Not part of any turn',
  'group.unattributed': 'Unattributed calls',
  'group.unattributedMeta': 'Never went through ctx.llm',
  // -- coord --
  'coord.purpose': 'Purpose',
  'coord.purposeTitle': 'A background auxiliary call, not part of any conversation turn.',
  'coord.turn': 'Turn',
  'coord.turnTitle': 'Which turn of the conversation.',
  'coord.step': 'Step',
  'coord.stepTitle': 'One step = one model call.',
  'coord.attribution': 'Attribution',
  'coord.provider': 'Provider',
  'coord.providerTitle': 'The resolved provider route.',
  'coord.session': 'Session',
  'coord.none': '—',
  // -- badge --
  'badge.unattributed': 'Unattributed',
  'badge.unattributedNoLlm': 'This request never went through ctx.llm, so the plugin cannot tell which conversation turn it belongs to.',
  'badge.unattributedOutsideTurn': 'This call happened outside of any turn.',
  // -- session --
  'session.none': 'No session',
  'session.current': 'This session',
  'session.noneTitle': 'This request carried no session marker on the wire.',
  // -- purpose --
  'purpose.sessionTitle': 'Title generation',
  'purpose.compaction': 'Context compaction',
  // -- json --
  'json.copyNode': 'Copy this node',
  'json.collapseBlock': 'Click to collapse',
  // -- curl --
  'curl.copiedWithKey': 'Copied, including the resolved real credential — it is now on your clipboard, so be careful with shell history / screen sharing.',
  // -- interpolated templates (formerly the standalone helper functions) --
  'session.foreignLabel': 'session {shortId}',
  'session.title': 'session {sessionId}',
  'session.fullIdTitle': 'Full session id: {sessionId}',
  'turn.groupLabel': 'Turn {turn}',
  'turn.groupMetaWithSteps': '{calls} calls · {steps} steps',
  'turn.groupMetaNoSteps': '{calls} calls',
  'badge.auxiliaryTitle': 'Background auxiliary call ({label}), not part of any conversation turn, so it has no step coordinate.',
  'badge.stepTitle': 'Turn {turn}, step {step} of the conversation (one step = one model call).',
  'badge.turnOnlyTitle': 'Turn {turn} of the conversation; this call happened between two steps.',
  'notice.truncatedBody': 'The original content was {totalChars} characters, over the cap, so only the first {keptChars} characters were kept. A body cut mid-JSON cannot be parsed, so it can only be shown as raw text; raising maxBodyChars keeps more of it.',
  'notice.hiddenUnattributed': '{count} more unattributed records exist (requests that never went through ctx.llm) — click "{scopeAll}" to see them.',
  'json.truncatedNotice': 'Too much content; truncated to {rows} rows.',
  'curl.copiedWithEnvRef': 'Copied — authorization references ${envName}; export {envName}=<your key> once, and it works without editing the command.',
  'curl.failed': 'Generation failed: {message}',
  'depth.label': 'Depth {depth}/{contentDepth}',
}
