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
  '.wt-list{flex:1;min-height:0;overflow-y:auto}',
  '.wt-item{cursor:pointer;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;gap:3px}',
  '.wt-item:hover{background:var(--dsw-alias-bg-layer-2)}',
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
  '.wt-tabs{display:flex;align-items:center;gap:4px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l2);flex-wrap:wrap}',
  '.wt-pre{flex:1;min-height:0;margin:0;padding:12px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-family:var(--ds-font-family-code);font-size:12px;line-height:19px;background:var(--dsw-alias-markdown-code-block)}',
  '.wt-empty{padding:24px;color:var(--dsw-alias-label-secondary);text-align:center}',
  '.wt-err{padding:8px 10px;color:var(--dsw-alias-state-error-primary);font-size:12px}',
  '.wt-json{flex:1;min-height:0;overflow:auto;padding:6px 0;background:var(--dsw-alias-markdown-code-block);font-family:var(--ds-font-family-code);font-size:12px;line-height:20px}',
  '.wt-jrow{display:flex;align-items:stretch;padding-right:28px;position:relative;white-space:pre}',
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
  '.wt-jcopy{position:absolute;right:4px;top:0;opacity:0;border:none;background:0 0;color:var(--shiki-token-comment);cursor:pointer;font-size:12px;line-height:20px;padding:0 4px}',
  '.wt-jrow:hover .wt-jcopy{opacity:1}',
  '.wt-jcopy:hover{color:var(--dsw-alias-label-primary)}',
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
  '.wt-coords{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l2);font-size:11px;color:var(--dsw-alias-label-secondary)}',
  '.wt-coord{display:flex;align-items:baseline;gap:4px}',
  '.wt-coord b{font-weight:600;color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family-code);font-size:12px}',
  '.wt-coord-sep{width:1px;height:12px;background:var(--dsw-alias-border-l2)}',
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
