/** The one CORA bind-conflict wording — CoraDock.startWithRetry (cora-dock.ts)
 *  emits it identically for the primary and every extra dock, and users paste
 *  it into issue reports verbatim. */
export function coraPortConflict(primary: number, child: number, detail: string): string {
  return `CORA port ${primary}/${child} in use — is another DeckBridge / Elgato dock running? (${detail})`;
}
