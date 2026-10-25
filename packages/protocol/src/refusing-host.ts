import { ERROR_CODES, ProtocolHostError, type ProtocolHost } from './index.js';

export const NOT_WIRED =
  'the serve host has no composition root yet: sessions, turns and attachments need the kernel wiring that lands with the composition root';

/**
 * The host slot, filled with a refusal.
 *
 * It exists so the process layer can be built and *tested* — framing, the handshake,
 * stdin EOF, signals, the exit code — before the composition root that can actually
 * answer exists. Every method refuses with the same reason, and the reason names what
 * is missing: a placeholder that returned empty success would be far worse, because a
 * client would read "no sessions" as a fact.
 *
 * Methods take no parameters on purpose. `Promise<never>` is assignable to every
 * method's result, and the parameters are irrelevant to a refusal — but a function with
 * unused parameters is a lint error here, so the shorter form is also the honest one.
 */
export function refusingHost(reason: string = NOT_WIRED): ProtocolHost {
  const refuse = (): Promise<never> => Promise.reject(new ProtocolHostError(reason, ERROR_CODES.hostRefused));

  return {
    serverVersion: '0.0.0+unwired',
    listSessions: () => refuse(),
    createSession: () => refuse(),
    attach: () => refuse(),
    forkSession: () => refuse(),
    sendTurn: () => refuse(),
    cancelTurn: () => refuse(),
    listModels: () => refuse(),
    setModel: () => refuse(),
    compactSession: () => refuse(),
    listGrants: () => refuse(),
    revokeGrant: () => refuse(),
    undoChange: () => refuse(),
    redoChange: () => refuse(),
    respondApproval: () => refuse(),
    setPlanMode: () => refuse(),
    setAcceptEdits: () => refuse(),
    respondPlan: () => refuse(),
    readAttachment: () => refuse(),
    stopTask: () => refuse(),
    listCronJobs: () => refuse(),
    removeCronJob: () => refuse(),
    trustStatus: () => refuse(),
    trustGrant: () => refuse(),
  };
}
