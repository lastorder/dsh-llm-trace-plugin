/**
 * Track the live turn/step of every session by following the loop's own
 * boundary events.
 *
 * The loop appends `step/start` immediately before a model call and `step/end`
 * immediately after it (`dsh-agent-loop`), so a call that begins while a step
 * is open belongs to that step. Between steps — and during auxiliary calls
 * made outside any turn — the session has no open step, and this reports null
 * rather than the most recently seen one: "the last step we saw" is exactly
 * the kind of plausible-looking wrong answer this plugin must never give.
 *
 * @module dsh-llm-trace-plugin/host/step-tracker
 */

export interface SessionEvent {
  type: string
  data?: {
    turn?: number
    step?: number
  }
}

export interface OpenCoordinates {
  turn: number | null
  step: number | null
}

export interface StepTracker {
  observe(sessionId: string, event: SessionEvent): void
  current(sessionId: string): OpenCoordinates
  forget(sessionId: string): void
  size(): number
}

export function createStepTracker(): StepTracker {
  /** sessionId -> the currently OPEN coordinates (never a stale, closed one). */
  const open = new Map<string, OpenCoordinates>()
  const at = (sessionId: string): OpenCoordinates => open.get(sessionId) ?? { turn: null, step: null }

  return {
    observe(sessionId, event) {
      if (typeof sessionId !== 'string') return
      if (event === null || typeof event !== 'object') return
      const data = event.data ?? {}
      switch (event.type) {
        case 'turn/start':
          open.set(sessionId, { turn: data.turn ?? null, step: null })
          break
        case 'step/start':
          open.set(sessionId, { turn: data.turn ?? null, step: data.step ?? null })
          break
        case 'step/end':
          // Keep the still-open turn, drop the closed step, so a call landing
          // between two steps is not misattributed to the one that just ended.
          open.set(sessionId, { turn: at(sessionId).turn, step: null })
          break
        case 'turn/end':
          open.delete(sessionId)
          break
        default:
          break
      }
    },
    current(sessionId) {
      return at(sessionId)
    },
    forget(sessionId) {
      open.delete(sessionId)
    },
    size() {
      return open.size
    },
  }
}
