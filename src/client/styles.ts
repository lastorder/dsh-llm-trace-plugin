/**
 * Stylesheet for the Wire Trace tab, and the disposer that inserts it once.
 *
 * @module dsh-llm-trace-plugin/client/styles
 */

import { STYLE_ID } from './constants.js'

export const CSS = [
  // ---- fix for the shell's own layout: in the "active" phase (any open,
  // non-blank session — i.e. always, for us) the shipped ConversationRoot
  // CSS sets the ancestor it calls `viewArea` to `flex:1 0 auto;
  // min-height:auto`, intentionally so Chat's message list can grow past
  // the visible area and let the whole page (`[data-conversation-scroll]`,
  // a stable framework attribute) scroll with a sticky composer. That same
  // rule unavoidably reaches every `conversation.view` entry, including
  // ours, which breaks OUR internal two-pane independent scrolling: with
  // no bounded height to overflow against, .wt-root grows to its content
  // and the whole page scrolls as one instead of the list and detail panes
  // scrolling on their own. `viewArea` has no stable selector of its own
  // (a build-hashed class), but it IS structurally exactly the parent of
  // the slot outlet's `[data-slot="conversation.view"]` marker (itself a
  // stable, non-hashed attribute the slot renderer always adds) — so it
  // can be targeted by that relationship alone, scoped narrowly to only
  // when OUR tab is the one currently mounted inside it via :has(.wt-root),
  // never touching Chat/Trajectory/other tabs' own instances of the exact
  // same ancestor.
  'div:has(>[data-slot="conversation.view"]):has(.wt-root){min-height:0!important;overflow:hidden!important;flex:1 1 0!important}',
  '.wt-root{display:flex;height:100%;min-height:0;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}',
  '.wt-left{width:360px;flex:none;display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--dsw-alias-border-l2)}',
  '.wt-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l2)}',
  '.wt-btn{cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);border-radius:6px;padding:3px 8px;font-size:12px;line-height:18px}',
  '.wt-btn:hover{color:var(--dsw-alias-label-primary)}',
  '.wt-btn[data-on="1"]{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
  '.wt-btn:disabled{opacity:.45;cursor:default}',
  // Depth stepper: square, monospaced glyphs so + and − sit at equal width.
  '.wt-btn-step{font-family:var(--ds-font-family-code);font-weight:600;padding:3px 0;width:26px;text-align:center}',
  '.wt-div{width:1px;height:16px;flex:none;align-self:center;margin:0 8px;background:var(--dsw-alias-border-l2)}',
  '.wt-meta{color:var(--dsw-alias-label-secondary);font-size:12px;margin-left:auto}',
  // The counter reads as text but behaves as a disclosure button: hovering a
  // plain span for a native `title` tooltip proved unreliable inside the
  // desktop shell, so the explanation opens on click instead. The trailing
  // `?` is the affordance that says so.
  '.wt-count{margin-left:auto;display:inline-flex;align-items:center;gap:4px;background:none;border:0;padding:0;font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}',
  '.wt-count:hover,.wt-count[data-on="1"]{color:var(--dsw-alias-label-primary)}',
  '.wt-count::after{content:"?";display:inline-block;width:12px;height:12px;border:1px solid currentColor;border-radius:50%;font-size:9px;line-height:12px;text-align:center;opacity:.6}',
  '.wt-count-note{padding:6px 10px;display:flex;flex-direction:column;gap:2px;border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}',
  '.wt-count-hint{opacity:.7}',
  '.wt-list{flex:1;min-height:0;overflow-y:auto}',
  '.wt-item{cursor:pointer;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;gap:3px}',
  '.wt-item:hover{background:var(--dsw-alias-bg-layer-2)}',
  '.wt-item[data-base="1"]{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 8%,transparent);box-shadow:inset 2px 0 0 var(--dsw-alias-state-warn-primary)}',
  '.wt-basetag{flex:none;font-size:11px;line-height:16px;padding:0 6px;border-radius:4px;color:var(--dsw-alias-state-warn-primary);border:1px dashed var(--dsw-alias-state-warn-primary)}',
  '.wt-item[data-sel="1"]{background:var(--dsw-alias-bg-layer-2);box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary)}',
  '.wt-row{display:flex;align-items:center;gap:6px;min-width:0}',
  '.wt-model{font-weight:500;text-overflow:ellipsis;white-space:nowrap;overflow:hidden;min-width:0;flex:1}',
  '.wt-sub{color:var(--dsw-alias-label-secondary);font-size:11px;display:flex;gap:8px;flex-wrap:wrap}',
  '.wt-tag{font-size:11px;border-radius:999px;padding:0 6px;line-height:16px;flex:none;border:1px solid var(--dsw-alias-border-l2)}',
  '.wt-tag[data-k="ok"]{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}',
  '.wt-tag[data-k="err"]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
  '.wt-tag[data-k="warn"]{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}',
  '.wt-tag[data-k="live"]{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
  '.wt-right{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0}',
  // ---- detail pane: identity header, tab bar, view-specific sub-bar ----
  '.wt-head{display:flex;flex-direction:column;gap:2px;padding:10px 12px 4px}',
  '.wt-head-main{display:flex;align-items:center;gap:8px;min-width:0}',
  '.wt-head-model{font-size:14px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.wt-head-stats{margin-left:auto;flex:none;color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap}',
  '.wt-head-url{font-family:var(--ds-font-family-code);font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.wt-tabs{display:flex;align-items:flex-end;justify-content:space-between;gap:8px;padding:0 10px;border-bottom:1px solid var(--dsw-alias-border-l2);flex-wrap:wrap}',
  '.wt-tablist{display:flex;gap:2px}',
  '.wt-tab{cursor:pointer;background:none;border:0;border-bottom:2px solid transparent;margin-bottom:-1px;padding:8px 12px;font-size:13px;color:var(--dsw-alias-label-secondary)}',
  '.wt-tab:hover{color:var(--dsw-alias-label-primary)}',
  '.wt-tab[data-on="1"]{color:var(--dsw-alias-label-primary);font-weight:600;border-bottom-color:var(--dsw-alias-brand-primary)}',
  '.wt-actions{display:flex;align-items:center;gap:4px;padding:4px 0}',
  '.wt-subbar{display:flex;align-items:center;gap:6px;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
  '.wt-subbar-fill{flex:1}',
  '.wt-subbar .wt-meta{margin:0 2px 0 0}',
  '.wt-pre{flex:1;min-height:0;margin:0;padding:12px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-family:var(--ds-font-family-code);font-size:12px;line-height:19px;background:var(--dsw-alias-markdown-code-block)}',
  '.wt-empty{padding:24px;color:var(--dsw-alias-label-secondary);text-align:center}',
  '.wt-err{padding:8px 10px;color:var(--dsw-alias-state-error-primary);font-size:12px}',
  '.wt-json{flex:1;min-height:0;overflow:auto;padding:6px 0;background:var(--dsw-alias-markdown-code-block);font-family:var(--ds-font-family-code);font-size:12px;line-height:20px}',
  '.wt-jrow{display:flex;align-items:stretch;padding-right:12px;white-space:pre}',
  '.wt-jrow[data-c="1"]{cursor:pointer}',
  '.wt-jrow:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.wt-jind{display:inline-block;width:14px;flex:none;border-left:1px solid var(--dsw-alias-border-l1)}',
  // The gutter is the per-row +/- affordance: dim until the row is hovered,
  // so a deep document reads as jq output rather than a column of symbols.
  '.wt-jgutter{display:inline-block;width:16px;flex:none;text-align:center;color:var(--shiki-token-punctuation);opacity:.45;font-weight:600}',
  '.wt-jrow:hover .wt-jgutter{opacity:1;color:var(--dsw-alias-label-primary)}',
  '.wt-jbody{min-width:0;flex:0 1 auto;overflow:hidden;text-overflow:ellipsis}',
  '.wt-jkey{color:var(--shiki-token-function)}',
  '.wt-jpunct{color:var(--shiki-token-punctuation);opacity:.75}',
  '.wt-jstr{color:var(--shiki-token-string)}',
  '.wt-jnum{color:var(--shiki-token-parameter)}',
  '.wt-jbool{color:var(--shiki-token-constant)}',
  '.wt-jnull{color:var(--shiki-token-comment);font-style:italic}',
  '.wt-jsum{color:var(--shiki-token-comment)}',
  '.wt-jmeta{color:var(--shiki-token-comment)}',
  '.wt-jclip{cursor:pointer;text-decoration:underline dotted;text-underline-offset:2px}',
  '.wt-jblock{margin:2px 28px 6px 30px;padding:8px 10px;border-left:2px solid var(--shiki-token-string);background:var(--dsw-alias-bg-layer-2);color:var(--shiki-token-string);white-space:pre-wrap;word-break:break-word;max-height:320px;overflow:auto;cursor:pointer}',
  // Copy pill: follows the value, hidden (but laid out, so rows never shift)
  // until the row is hovered or the button focused. The ::after widens the
  // hit area past the visible pill.
  '.wt-jcopy{position:relative;flex:none;align-self:center;display:inline-flex;align-items:center;gap:4px;margin-left:10px;height:18px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-sans,inherit);font-size:11px;line-height:16px;white-space:nowrap;cursor:pointer;opacity:0}',
  '.wt-jcopy::after{content:"";position:absolute;inset:-3px -2px}',
  '.wt-jrow:hover .wt-jcopy,.wt-jcopy:focus-visible,.wt-jcopy[data-done="1"]{opacity:1}',
  '.wt-jcopy:hover{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
  '.wt-jcopy:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
  '.wt-jcopy[data-done="1"]{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}',
  '.wt-jcopy-icon{font-size:12px;line-height:1}',
  '.wt-jnotice{padding:6px 12px;color:var(--shiki-token-comment);font-size:11px}',
  '.wt-sse{flex:1;min-height:0;margin:0;padding:12px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-family:var(--ds-font-family-code);font-size:12px;line-height:19px;background:var(--dsw-alias-markdown-code-block)}',
  // ---- turn/step presentation ----
  // A sticky group header so a long list still tells you which turn you
  // are looking at while scrolling.
  '.wt-turn{position:sticky;top:0;z-index:1;display:flex;align-items:center;gap:8px;padding:5px 10px;background:var(--dsw-alias-bg-layer-2);border-bottom:1px solid var(--dsw-alias-border-l2);border-top:1px solid var(--dsw-alias-border-l2);font-size:11px;color:var(--dsw-alias-label-secondary)}',
  '.wt-turn-n{font-weight:600;color:var(--dsw-alias-label-primary)}',
  '.wt-turn-meta{margin-left:auto}',
  // The step coordinate: monospaced so digits line up down the column.
  '.wt-step{font-family:var(--ds-font-family-code);font-size:11px;flex:none;border-radius:4px;padding:0 5px;line-height:16px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}',
  '.wt-step[data-k="step"]{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
  '.wt-step[data-k="aux"]{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}',
  '.wt-step[data-k="none"]{opacity:.6}',
  // Detail-pane coordinate strip: the same facts, always visible above the body.
  '.wt-coords{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:2px 12px 8px;font-size:11px;color:var(--dsw-alias-label-secondary)}',
  '.wt-coord{display:flex;align-items:baseline;gap:4px}',
  '.wt-coord b{font-weight:600;color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family-code);font-size:12px}',
  '.wt-coord-sep{width:1px;height:12px;background:var(--dsw-alias-border-l2)}',
  // ---- Compare tab: request-body diff ----
  '.wt-cmp{flex:1;min-height:0;display:flex;flex-direction:column}',
  '.wt-cmp-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
  '.wt-cmp-label{flex:none;font-size:12px;color:var(--dsw-alias-label-secondary)}',
  '.wt-select{flex:1 1 240px;min-width:0;max-width:520px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:6px;padding:3px 6px;font-size:12px;line-height:18px}',
  '.wt-cmp-note{font-size:11px;color:var(--dsw-alias-label-secondary)}',
  '.wt-cmp-sum{display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
  '.wt-chip{flex:none;font-family:var(--ds-font-family-code);font-size:11px;line-height:16px;padding:0 7px;border-radius:999px}',
  '.wt-chip[data-k="added"]{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent)}',
  '.wt-chip[data-k="removed"]{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 14%,transparent)}',
  '.wt-chip[data-k="changed"]{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 14%,transparent)}',
  '.wt-cmp-msg{padding:24px;line-height:20px;text-align:center;color:var(--dsw-alias-label-secondary)}',
  '.wt-cmp-body{flex:1;min-height:0;overflow:auto;padding:10px 0 16px}',
  '.wt-cg{margin:0 10px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden}',
  '.wt-cg-head{display:flex;align-items:center;gap:8px;width:100%;padding:6px 10px;border:0;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;text-align:left;cursor:pointer}',
  '.wt-cg-caret{width:10px;flex:none;color:var(--dsw-alias-label-secondary)}',
  '.wt-cg-key{font-family:var(--ds-font-family-code);font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.wt-cg-meta{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary)}',
  '.wt-cg-counts{margin-left:auto;display:flex;gap:4px}',
  '.wt-cg-body{display:flex;flex-direction:column}',
  '.wt-cg-more{align-self:flex-start;margin:6px 10px}',
  '.wt-cr{display:flex;flex-direction:column;gap:2px;padding:6px 10px;border-top:1px solid var(--dsw-alias-border-l1);font-family:var(--ds-font-family-code);font-size:12px;line-height:18px}',
  '.wt-cr-path{font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-all}',
  '.wt-cv{display:flex;align-items:flex-start;gap:8px;padding:1px 6px;border-radius:4px}',
  '.wt-cv[data-k="add"]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent)}',
  '.wt-cv[data-k="del"]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}',
  '.wt-cv[data-k="chg"]{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 8%,transparent)}',
  '.wt-cv-mark{flex:none;width:10px;text-align:center;font-weight:600}',
  '.wt-cv[data-k="add"] .wt-cv-mark,.wt-ld-row[data-k="add"] .wt-ld-mark{color:var(--dsw-alias-state-success-primary)}',
  '.wt-cv[data-k="del"] .wt-cv-mark,.wt-ld-row[data-k="del"] .wt-ld-mark{color:var(--dsw-alias-state-error-primary)}',
  '.wt-cv[data-k="chg"] .wt-cv-mark{color:var(--dsw-alias-state-warn-primary)}',
  '.wt-cv-text{flex:1 1 auto;min-width:0;white-space:pre-wrap;word-break:break-word}',
  '.wt-cv-wrap{max-height:12em;overflow:auto}',
  '.wt-cv-click{cursor:pointer}',
  '.wt-cv-click:hover{text-decoration:underline dotted;text-underline-offset:2px}',
  '.wt-cv-meta{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary)}',
  '.wt-cv del{text-decoration:none;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 32%,transparent);border-radius:2px}',
  '.wt-cv ins{text-decoration:none;background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 32%,transparent);border-radius:2px}',
  '.wt-cv-full{margin:2px 0 4px 24px;padding:8px 10px;max-height:320px;overflow:auto;white-space:pre-wrap;word-break:break-word;font:inherit;background:var(--dsw-alias-markdown-code-block);border-left:2px solid var(--dsw-alias-border-l2);cursor:pointer}',
  '.wt-cv-full[data-k="add"]{border-left-color:var(--dsw-alias-state-success-primary)}',
  '.wt-cv-full[data-k="del"]{border-left-color:var(--dsw-alias-state-error-primary)}',
  '.wt-ld{max-height:360px;overflow:auto;border-radius:4px}',
  '.wt-ld-row{display:flex;gap:8px;padding:0 6px;white-space:pre-wrap;word-break:break-word}',
  '.wt-ld-row[data-k="add"]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent)}',
  '.wt-ld-row[data-k="del"]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}',
  '.wt-ld-mark{flex:none;width:10px;text-align:center;font-weight:600}',
  '.wt-ld-text{min-width:0}',
  '.wt-ld-skip{padding:0 6px 0 24px;font-size:11px;font-style:italic;color:var(--dsw-alias-label-secondary)}',
  '.wt-unch{margin:4px 10px 0;font-size:12px;color:var(--dsw-alias-label-secondary)}',
  '.wt-unch summary{cursor:pointer}',
  '.wt-unch-list{display:flex;flex-wrap:wrap;gap:4px;padding-top:6px}',
  '.wt-unch-key{font-family:var(--ds-font-family-code);font-size:11px;padding:0 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:4px}',
  // ---- plugin management page panel (plugins.bundle.config) ----
  '.wt-manage{display:flex;flex-direction:column;gap:10px;font-size:13px;color:var(--dsw-alias-label-primary)}',
  '.wt-manage-stats{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
  '.wt-manage-stats-label{font-weight:600}',
  '.wt-manage-stats-line{color:var(--dsw-alias-label-secondary);font-size:12px}',
  '.wt-manage-fields{display:flex;flex-direction:column;gap:10px;padding-top:4px;border-top:1px solid var(--dsw-alias-border-l2)}',
  '.wt-manage-fields-label{font-weight:600}',
  '.wt-mfield{display:grid;grid-template-columns:220px minmax(160px,320px);column-gap:12px;row-gap:2px;align-items:center}',
  '.wt-mfield-label{color:var(--dsw-alias-label-primary);font-size:12px}',
  '.wt-mfield-input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:6px;padding:3px 8px;font-size:12px;line-height:18px;width:100%}',
  '.wt-mfield-input:disabled{opacity:.6}',
  '.wt-mfield-hint{grid-column:1/-1;color:var(--dsw-alias-label-secondary);font-size:11px}',
  '.wt-mfield-notice{grid-column:1/-1;font-size:11px}',
  '.wt-mfield-notice[data-k="ok"]{color:var(--dsw-alias-state-success-primary)}',
  '.wt-mfield-notice[data-k="err"]{color:var(--dsw-alias-state-error-primary)}',
].join('\n')

/** Insert the stylesheet once per document, returning an idempotent disposer. */
export function insertStyles(): () => void {
  const selector = 'style[data-plugin-css=' + JSON.stringify(STYLE_ID) + ']'
  if (document.querySelector(selector) !== null) return () => {}
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-llm-trace-plugin'
  tag.dataset.pluginCss = STYLE_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
  return () => { tag.remove() }
}
