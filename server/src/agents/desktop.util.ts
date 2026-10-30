/**
 * A desktop launch's refusals, in the words the launch sheet shows.
 *
 * Every other spawn refusal is relayed verbatim (`AgentsService.spawn`'s note says why: the dashboard's own wording is short and names the one detail the
 * reader needs). A desktop launch is the exception, because the dashboard's desktop refusals are terse codes written for its own launch form — `open failed`
 * and `desktop app unavailable` read, on the board, as if the BOARD had failed to open something — and three of them describe a hand-over this board never
 * sends. Each is named here by the dashboard's exact text and status (`claude-agents-dashboard` `server/api.ts`, `spawnDesktop` and `resumeTarget`), so a
 * reworded refusal over there falls through to the verbatim relay rather than to a wrong sentence.
 *
 * Pure, and keyed on the status the dashboard answered, not the one this board relays it with: `spawn` collapses anything outside 400–499 to 502, which
 * would make `open failed` (500) and `desktop app unavailable` (501) indistinguishable here.
 */
export function desktopSpawnError(status: number, error: string): string {
  if (status === 400 && error === 'bad surface') {
    return 'the dashboard did not accept the Desktop pick — update claude-agents-dashboard on this Mac, or launch on Dashboard';
  }
  if (status === 409 && error === 'session is open in the desktop app') return 'that session is already open in the desktop app';
  if (status === 409 && error === 'already resuming') return 'that session is already being handed to the desktop app — give it a few seconds';
  if (status === 429) return 'the desktop app was asked to open several sessions in the last few seconds — wait a moment and launch again';
  if (status === 500 && error === 'open failed') return "couldn't open the desktop app on this Mac — is Claude installed and able to start?";
  if (status === 501) return 'the desktop app is not available on this Mac — launch on Dashboard instead';
  return error;
}
