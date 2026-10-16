import hljs from 'highlight.js/lib/core';
import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import php from 'highlight.js/lib/languages/php';
import lua from 'highlight.js/lib/languages/lua';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import sql from 'highlight.js/lib/languages/sql';
import yaml from 'highlight.js/lib/languages/yaml';
import diff from 'highlight.js/lib/languages/diff';
import markdown from 'highlight.js/lib/languages/markdown';
import csharp from 'highlight.js/lib/languages/csharp';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';

// Only the languages that show up in these chats; each one costs bundle size. A fence in anything else stays plain.
const LANGS: [string, Parameters<typeof hljs.registerLanguage>[1], string[]][] = [
  ['typescript', typescript, ['ts', 'tsx']], ['javascript', javascript, ['js', 'jsx', 'mjs', 'cjs']], ['json', json, ['jsonc']],
  ['bash', bash, ['sh', 'shell', 'zsh', 'console']], ['powershell', powershell, ['ps1', 'pwsh', 'ps']], ['python', python, ['py']],
  ['php', php, []], ['lua', lua, ['luau']], ['css', css, ['scss']], ['xml', xml, ['html', 'svg', 'vue']], ['sql', sql, []], ['yaml', yaml, ['yml']],
  ['diff', diff, ['patch']], ['markdown', markdown, ['md']], ['csharp', csharp, ['cs']], ['go', go, ['golang']], ['rust', rust, ['rs']],
];
for (const [name, def, aliases] of LANGS) hljs.registerLanguage(name, def), aliases.length && hljs.registerAliases(aliases, { languageName: name });

/** Highlighted HTML for a code block, or null when the language is unknown (the caller escapes and shows it plain). */
export function highlight(code: string, lang: string): string | null {
  if (!lang || !hljs.getLanguage(lang.toLowerCase()) || code.length > 40_000) return null;
  try { return hljs.highlight(code, { language: lang.toLowerCase(), ignoreIllegals: true }).value; } catch { return null; }
}
