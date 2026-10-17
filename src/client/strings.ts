/**
 * Every user-visible string in the Wire Trace tab and the plugin management
 * panel, in two languages.
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
 * it (`toolbar.clear`, `tabs.request`, …), joined with `.` — flat because
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
  'toolbar.clear': '清空',
  'toolbar.clearTitle': '清空本 session 的记录（内存与磁盘上的历史记录都会删除）。要清空全部 session 的历史记录，请前往插件管理页。',
  // -- counter (toolbar "A / B · N turn · N aux") --
  'count.title': '命中记录数 / 全部记录数（含磁盘）。点击展开说明。',
  'count.scopeSession': '本 session 内',
  'count.scopeAll': '当前过滤条件下',
  'count.helpMatch': '左边数字：{scope}命中的记录数，当前 {matched} 条。',
  'count.helpTotal': '右边数字：store 里的全部记录数（内存环形缓冲 + 磁盘历史），当前 {total} 条。',
  'count.helpRows': '列表这一屏只渲染了 {shown} 行（每屏最多 {limit} 行），另有 {hidden} 条命中记录没有画出来 —— 它们仍在 store 里，不是丢失了。',
  'count.helpRowsAll': '列表这一屏渲染了全部 {shown} 行命中记录。',
  'count.helpTurns': '· {turns} turn：列表里出现过的对话轮数；同一轮里的多次模型调用（每次调用是一个 step）只计 1 轮。',
  'count.helpAux': '· {auxiliary} 辅助：标题生成、上下文压缩这类不属于任何对话轮的后台调用。',
  'count.helpHint': '点击这行数字可收起说明。',
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
  // -- manage: the plugin management page panel (entry.ts registers it at plugins.bundle.config) --
  'manage.statsLabel': '本地缓存',
  'manage.statsLoading': '正在读取缓存信息…',
  'manage.statsLine': '内存中 {memory} 条 · 磁盘已保存 {retained} 条（上限 {maxRecords}）',
  'manage.statsLineNoPersist': '内存中 {memory} 条（磁盘持久化已关闭）',
  'manage.statsError': '读取缓存信息失败：{message}',
  'manage.clearAllButton': '清除全部历史记录',
  'manage.clearAllTitle': '清空全部 session 的记录：内存中的实时记录和磁盘上持久化的历史记录都会被删除，且不可恢复。',
  'manage.clearAllConfirm': '确定要清除全部历史记录吗？这会删除所有 session 的记录（内存与磁盘），且不可恢复。',
  'manage.clearAllDone': '已清空全部历史记录。',
  'manage.clearAllFailed': '清除失败：{message}',
  'manage.fieldsLabel': '参数配置',
  'manage.fieldsReadOnlyNotice': '当前环境不支持在线修改配置；可改为编辑 profile 里本插件的 cordis.patch.yml config: 字段（参见 README）。以下显示的是当前生效的值。',
  'manage.fieldsUsingDefaults': '未能读取当前生效的配置，以下显示的是各参数的默认值，仅供参考，暂不可在线编辑。',
  'manage.fieldsLoading': '正在读取当前配置…',
  'manage.fieldSaved': '已保存。',
  'manage.fieldSaveFailed': '保存失败：{message}',
  'manage.resetToDefault': '恢复默认',
  'manage.field.maxRecords.label': '内存环形缓冲区大小 (maxRecords)',
  'manage.field.maxRecords.hint': '无论是否持久化，内存中保留的最近记录条数。',
  'manage.field.maxBodyChars.label': '单字段字符上限 (maxBodyChars)',
  'manage.field.maxBodyChars.hint': '捕获的请求/响应正文中，每个字段被截断前的字符数上限。',
  'manage.field.persist.label': '持久化到磁盘 (persist)',
  'manage.field.persist.hint': '关闭后退回纯内存环形缓冲区，不再向磁盘写入任何内容。',
  'manage.field.traceDir.label': '持久化目录 (traceDir)',
  'manage.field.traceDir.hint': '记录文件存放的目录；清空此项将恢复为 $DSH_HOME/llm-wire-trace/records（或 ~/.dsh/llm-wire-trace/records）。',
  'manage.field.maxPersistedRecords.label': '磁盘保留记录数 (maxPersistedRecords)',
  'manage.field.maxPersistedRecords.hint': '磁盘上保留的记录文件数量上限，超出后最旧的会被清理。',
  'manage.field.historyPageLimit.label': '历史分页大小 (historyPageLimit)',
  'manage.field.historyPageLimit.hint': '查询磁盘历史记录时，单页最多读取的文件数。',
  'manage.field.prettyBodyLimit.label': '可读副本大小上限 (prettyBodyLimit)',
  'manage.field.prettyBodyLimit.hint': '正文超过这个字符数时，磁盘上就不再额外写入便于阅读的格式化副本。',
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
  'notice.hiddenUnattributed': '另有 {count} 条无归属记录（没有经过 ctx.llm 的请求）在当前 session 筛选下不可见。',
  'json.truncatedNotice': '内容过多，已截断到 {rows} 行。',
  'curl.copiedWithEnvRef': '已复制，authorization 引用了 ${envName}；先 export {envName}=你的密钥，再运行就不用改命令了。',
  'curl.failed': '生成失败：{message}',
  'depth.label': '深度 {depth}/{contentDepth}',
}

/** English dictionary. Every key here must also exist in {@link zh}, and vice versa. */
export const en: LocaleDict = {
  // -- toolbar --
  'toolbar.clear': 'Clear',
  'toolbar.clearTitle': 'Clear this session\'s records (both the in-memory ring and its persisted history on disk). To clear every session\'s history, use the plugin management page.',
  // -- counter (toolbar "A / B · N turn · N aux") --
  'count.title': 'Matching records / all records (including disk). Click for details.',
  'count.scopeSession': 'in this session',
  'count.scopeAll': 'under the current filter',
  'count.helpMatch': 'Left number: records matching {scope} — {matched} right now.',
  'count.helpTotal': 'Right number: every record the store holds (in-memory ring + on-disk history) — {total} right now.',
  'count.helpRows': 'This screen renders {shown} rows (at most {limit} per page); {hidden} more matching records are not drawn — they are still in the store, not lost.',
  'count.helpRowsAll': 'This screen renders all {shown} matching rows.',
  'count.helpTurns': '· {turns} turn: conversation turns present in the list; several model calls (each one a step) inside a turn count as one turn.',
  'count.helpAux': '· {auxiliary} aux: background calls belonging to no turn, such as title generation or context compaction.',
  'count.helpHint': 'Click these numbers again to collapse this.',
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
  // -- manage: the plugin management page panel (entry.ts registers it at plugins.bundle.config) --
  'manage.statsLabel': 'Local cache',
  'manage.statsLoading': 'Reading cache stats…',
  'manage.statsLine': '{memory} in memory · {retained} persisted on disk (cap {maxRecords})',
  'manage.statsLineNoPersist': '{memory} in memory (disk persistence is off)',
  'manage.statsError': 'Failed to read cache stats: {message}',
  'manage.clearAllButton': 'Clear all history',
  'manage.clearAllTitle': 'Clears every session\'s records: both the live in-memory ring and the persisted history on disk are deleted, irreversibly.',
  'manage.clearAllConfirm': 'Clear all history? This deletes every session\'s records (memory and disk) and cannot be undone.',
  'manage.clearAllDone': 'All history cleared.',
  'manage.clearAllFailed': 'Clear failed: {message}',
  'manage.fieldsLabel': 'Parameters',
  'manage.fieldsReadOnlyNotice': 'Live editing is unavailable in this environment; edit this plugin\'s cordis.patch.yml config: block in the profile instead (see README). The values shown below are the ones currently in effect.',
  'manage.fieldsUsingDefaults': 'Could not read the configuration currently in effect, so the values below are each field\'s default, shown for reference only; editing is unavailable for now.',
  'manage.fieldsLoading': 'Reading current configuration…',
  'manage.fieldSaved': 'Saved.',
  'manage.fieldSaveFailed': 'Save failed: {message}',
  'manage.resetToDefault': 'Reset to default',
  'manage.field.maxRecords.label': 'In-memory ring size (maxRecords)',
  'manage.field.maxRecords.hint': 'How many recent records stay resident in memory, regardless of persistence.',
  'manage.field.maxBodyChars.label': 'Per-field character cap (maxBodyChars)',
  'manage.field.maxBodyChars.hint': 'Character cap on a captured request/response body field before truncation.',
  'manage.field.persist.label': 'Persist to disk (persist)',
  'manage.field.persist.hint': 'Disable for a pure in-memory ring that writes nothing to disk.',
  'manage.field.traceDir.label': 'Persistence directory (traceDir)',
  'manage.field.traceDir.hint': 'Directory records are written under; clearing this reverts to $DSH_HOME/llm-wire-trace/records (or ~/.dsh/llm-wire-trace/records).',
  'manage.field.maxPersistedRecords.label': 'Retained files on disk (maxPersistedRecords)',
  'manage.field.maxPersistedRecords.hint': 'Retained record files on disk before the oldest are swept.',
  'manage.field.historyPageLimit.label': 'History page size (historyPageLimit)',
  'manage.field.historyPageLimit.hint': 'Files read per on-disk archive listing page.',
  'manage.field.prettyBodyLimit.label': 'Readability copy cap (prettyBodyLimit)',
  'manage.field.prettyBodyLimit.hint': 'Above this body size, the pretty-printed on-disk readability copy is not written.',
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
  'notice.hiddenUnattributed': '{count} more unattributed records exist (requests that never went through ctx.llm), hidden by the current session filter.',
  'json.truncatedNotice': 'Too much content; truncated to {rows} rows.',
  'curl.copiedWithEnvRef': 'Copied — authorization references ${envName}; export {envName}=<your key> once, and it works without editing the command.',
  'curl.failed': 'Generation failed: {message}',
  'depth.label': 'Depth {depth}/{contentDepth}',
}
