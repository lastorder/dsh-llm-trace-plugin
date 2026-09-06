/**
 * Shared record shapes between the host (capture, persistence, HTTP routes)
 * and the client (the Wire Trace viewer).
 *
 * This module is TYPE-ONLY: nothing here has a runtime representation. The
 * client bundle imports these as `import type`, so none of it adds bytes to
 * the shipped browser script.
 *
 * @module dsh-llm-trace-plugin/shared/record-shape
 */
export {};
