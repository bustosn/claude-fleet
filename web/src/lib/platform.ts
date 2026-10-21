/** The browser's OS, for shortcuts and their labels: ⌘ on a Mac, Ctrl elsewhere. */
export const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

/** The app's shortcut modifier is down: Cmd on a Mac (Ctrl there belongs to the shell and the context menu), Ctrl elsewhere. */
export const modKey = (e: { metaKey: boolean; ctrlKey: boolean }) => isMac ? e.metaKey : e.ctrlKey;

/** Label for a shortcut with the modifier: `${MOD}K` reads ⌘K on a Mac and Ctrl+K elsewhere. */
export const MOD = isMac ? '⌘' : 'Ctrl+';
