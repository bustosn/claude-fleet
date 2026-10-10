import type { SlashCommandView } from './api';

/** Commands for the composer popup, best match first. Exact name, then name prefix, alias prefix, name substring,
 *  and last a description word starting with the query. Ties go to the shorter name, then alphabetical; a bare "/" lists everything alphabetically. */
export function rankCommands(commands: SlashCommandView[], query: string, limit = 20): SlashCommandView[] {
  const q = query.toLowerCase();
  const scored: { c: SlashCommandView; tier: number }[] = [];
  for (const c of commands) {
    const name = c.name.toLowerCase();
    const aliases = c.aliases.map(a => a.toLowerCase());
    let tier: number;
    if (!q) tier = 5;
    else if (name === q || aliases.includes(q)) tier = 0;
    else if (name.startsWith(q)) tier = 1;
    else if (aliases.some(a => a.startsWith(q))) tier = 2;
    else if (q.length > 1 && name.includes(q)) tier = 3;
    else if (q.length > 2 && c.description.toLowerCase().split(/\W+/).some(w => w.startsWith(q))) tier = 4;
    else continue;
    scored.push({ c, tier });
  }
  return scored
    .sort((a, b) => a.tier - b.tier || (q ? a.c.name.length - b.c.name.length : 0) || a.c.name.localeCompare(b.c.name))
    .slice(0, limit)
    .map(s => s.c);
}
