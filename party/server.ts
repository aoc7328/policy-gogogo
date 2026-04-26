import type * as Party from "partykit/server";

/**
 * Phase 1 stub. Phase 2 will implement:
 *   - onConnect / onClose: roster + roomState
 *   - onMessage: route by event type, validate controlCode for privileged ops
 *   - five rush-mode arbitration loops (speed/count/lightning/allhands/random)
 *   - question picker (BANK + usedIds)
 * The stub exists so `partykit dev` boots and `tsc --noEmit` passes.
 */
export default class PolicyGogogoServer implements Party.Server {
  constructor(readonly room: Party.Room) {}

  onConnect(_conn: Party.Connection, _ctx: Party.ConnectionContext) {
    // no-op stub; Phase 2 will replace with roster + welcome state push
  }
}
