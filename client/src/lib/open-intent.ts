/**
 * open-intent — which frame a click on a ticket opens (Jira detail tabs spec §2.3, decision 11; DESIGN.md §8.9.2). Pure: the surfaces read it off their own
 * click events and the platform string, so the rule is one function and not five expressions that could disagree.
 *
 * Every surface that opens Detail — a Board card, a List row, a deck card, a Sessions row, a Children row inside the modal — opens the MODAL on a plain click,
 * as it always has, and the full ticket PAGE on Cmd-click (macOS), Ctrl-click (elsewhere) or a middle-click. These surfaces are buttons, `role="button"`
 * divs and table rows, not links: there is no URL to open in a new browser tab, so the modifier is read off the event rather than left to the browser. Both
 * modifiers are honoured on every platform — the title names the platform's own, but a Ctrl-click on a Mac reaching `click` at all (some trackpads) or a
 * Cmd-click through a remote desktop should not quietly open the modal instead.
 */

/** The fields of a mouse event the rule reads — a React `MouseEvent` satisfies it, and a test can hand a plain object. */
export interface ClickLike {
  metaKey: boolean;
  ctrlKey: boolean;
  button: number;
}

/** Whether this click asks for the full page rather than the modal: a held Cmd or Ctrl, or the middle button (`button === 1`, an `auxclick`). */
export function wantsPage(e: ClickLike): boolean {
  return e.metaKey || e.ctrlKey || e.button === 1;
}

/**
 * The `title` each surface gains, naming the platform's own modifier: `⌘-click: full page` where the platform string says Mac, `Ctrl-click: full page`
 * everywhere else. Takes the string rather than reading `navigator`, so the wording is testable on any machine.
 */
export function fullPageTitle(platform: string): string {
  return /Mac/i.test(platform) ? '⌘-click: full page' : 'Ctrl-click: full page';
}

/**
 * The browser's platform string, for `fullPageTitle`: `navigator.userAgentData.platform` where the browser has it (Chromium, which deprecates
 * `navigator.platform`), else `navigator.platform`, else `''` — which reads as not-Mac, the wording for the larger share of machines.
 */
export function browserPlatform(): string {
  if (typeof navigator === 'undefined') return '';
  const data = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return data?.platform ?? navigator.platform ?? '';
}
