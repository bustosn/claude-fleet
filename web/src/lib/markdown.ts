import { highlight } from './highlight';

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const unesc = (s: string) => s.replace(/&(amp|lt|gt|quot);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"' }[e as 'amp']));

/** A path in running text: a drive path, or something with a slash and an extension. Not inside a URL or a longer word. */
const PATH = String.raw`(?<![\w/\\:.@-])(?:[A-Za-z]:[\\/][^\s\x60<>"'|*?()\[\]&]+|(?:~|\.{1,2})?[\\/]?(?:[\w.@-]+[\\/])+[\w@-][\w.@-]*\.[A-Za-z0-9]{1,8})(?::\d+(?::\d+)?)?`;
// One pass over prose: inline code, a markdown link, or a bare path. Matching all three together keeps a link from being linked twice.
const TOKEN = new RegExp(String.raw`\x60{3,}|\x60([^\x60]+)\x60|\[([^\]\n]+)\]\(([^)\s]+)\)|(${PATH})`, 'g');
/** Inline code that names a file: no spaces, and a slash, a drive, or a file name with an extension. */
const CODE_PATH = /^(?:[A-Za-z]:[\\/]\S*|\S*[\\/]\S*|[\w@-][\w.@-]*\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?)$/;

/** "src/a.ts:42", "src/a.ts:42:7" and "src/a.ts#L42" all name line 42 of src/a.ts. */
export function splitLine(ref: string): { path: string; line: number | null } {
  const m = /^(.*?)(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)?$/.exec(ref)!;
  return { path: m[1], line: m[2] || m[3] ? Number(m[2] || m[3]) : null };
}

/** `isFile` decides which named paths become links (the chat asks the server which exist). Without it, paths stay text. */
function linkify(prose: string, isFile?: (path: string) => boolean): string {
  const fileLink = (ref: string, inner: string) => {
    const { path, line } = splitLine(unesc(ref));
    if (!isFile?.(path)) return null;
    return `<a class="file-link" href="#" data-path="${esc(path)}"${line ? ` data-line="${line}"` : ''} title="Open ${esc(path)}${line ? `, line ${line}` : ''} (Ctrl+click: VS Code)">${inner}</a>`;
  };
  return prose.replace(TOKEN, (all, code?: string, text?: string, target?: string, bare?: string) => {
    if (code == null && text == null && bare == null) return all; // a run of ``` mid-sentence stays as typed
    if (code != null) {
      const c =`<code>${code}</code>`;
      return code.length < 300 && !/^[a-z][a-z+.-]*:\/\//i.test(code) && CODE_PATH.test(code) ? fileLink(code, c) ?? c : c;
    }
    if (text != null) {
      const inner = text.replace(/\x60([^\x60]+)\x60/g, '<code>$1</code>');
      if (/^https?:\/\//i.test(target!)) return `<a href="${target}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
      return fileLink(target!, inner) ?? inner;
    }
    // Sentence punctuation after a bare path is not part of it.
    const [, ref, tail] = /^(.*?)([.,;:!?]*)$/.exec(bare!)!;
    return (fileLink(ref, ref) ?? ref) + tail;
  });
}

const SEP_ROW = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const splitRow = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));
const NUMERIC = /^[\d,.\s%$+-]+$/;

/** GitHub-style pipe tables: a header row, a separator row of dashes, then body rows. Alignment follows the separator's colons; plain numbers right-align. */
function tables(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i + 1 < lines.length && lines[i].includes('|') && SEP_ROW.test(lines[i + 1])) {
      const head = splitRow(lines[i]);
      const align = splitRow(lines[i + 1]).map(c => c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : '');
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j].includes('|') && lines[j].trim()) rows.push(splitRow(lines[j++]));
      const cell = (tag: string, c: string, k: number) => {
        const a = align[k] || (tag === 'td' && c && NUMERIC.test(c) ? 'right' : '');
        return `<${tag}${a ? ` style="text-align:${a}"` : ''}${a === 'right' ? ' class="num"' : ''}>${c}</${tag}>`;
      };
      out.push(`<table><thead><tr>${head.map((c, k) => cell('th', c, k)).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${head.map((_, k) => cell('td', r[k] ?? '', k)).join('')}</tr>`).join('')}</tbody></table>`);
      i = j - 1;
    } else out.push(lines[i]);
  }
  return out.join('\n');
}

/** A fenced block: the first line after the fence names the language, which picks the highlighting. */
function codeBlock(raw: string): string {
  const m = /^([\w+#-]*)\n/.exec(raw);
  const lang = m?.[1] || '', code = m ? raw.slice(m[0].length) : raw;
  const html = highlight(code.replace(/\n$/, ''), lang);
  return `<div class="codeblock">${lang ? `<span class="code-lang">${esc(lang)}</span>` : ''}<button type="button" class="copy-btn" title="Copy to clipboard">Copy</button><pre><code${html ? ' class="hljs"' : ''}>${html ?? esc(code)}</code></pre></div>`;
}

/** Minimal markdown for chat replies: fenced code, inline code, links, bold, bullets, tables, paragraphs. Everything is escaped first. */
export function md(src: string, isFile?: (path: string) => boolean): string {
  const prose = (p: string) => tables(linkify(esc(p), isFile)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>'))
    .replace(/^(#{1,4}) (.*)$/gm, (_, h: string, t: string) => `<h${h.length}>${t}</h${h.length}>`)
    .replace(/^(?:- |\* )(.*)$/gm, '<li>$1</li>')
    // Newlines between items or after a heading would each become a <br> and open gaps in the block.
    .replace(/(<li>.*<\/li>\n?)+/g, m => `<ul>${m.replace(/\n/g, '')}</ul>`)
    .replace(/(<\/h\d>|<\/ul>|<\/table>)\n+/g, '$1')
    .replace(/\n+(<table>)/g, '$1')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/\n/g, '<br>');
  // A fence is ``` at the start of a line (indent allowed); ``` in the middle of a sentence is just text.
  // An unclosed fence runs to the end, as while a reply streams.
  const out: string[] = [];
  let last = 0;
  for (const m of src.matchAll(/^[ \t]*```([^\n`]*)\n?([\s\S]*?)(?:^[ \t]*```[ \t]*$|(?![\s\S]))/gm)) {
    out.push(prose(src.slice(last, m.index)), codeBlock(`${m[1].trim()}\n${m[2]}`));
    last = m.index! + m[0].length;
  }
  out.push(prose(src.slice(last)));
  return out.join('');
}

/** Quote-aware CSV/TSV parse. Returns null when the text is not a clean grid. */
function parseGrid(text: string, sep: string): string[][] | null {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false, wasQuoted = false;
  const endCell = () => { row.push(cell); cell = ''; wasQuoted = false; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += c;
    } else if (c === '"' && cell === '') { quoted = true; wasQuoted = true; }
    else if (c === sep) endCell();
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endCell(); rows.push(row); row = [];
    } else if (wasQuoted) return null; // stray text after a closing quote: not CSV
    else cell += c;
  }
  if (quoted) return null;
  if (cell !== '' || row.length) { endCell(); rows.push(row); }
  return rows;
}

/** A pasted CSV or spreadsheet (TSV) as a markdown table, or null when the text does not look like one: at least a header and two rows, two or more columns, every row the same width, short non-empty header cells. */
export function csvToMarkdownTable(text: string): string | null {
  const t = text.trim();
  if (!t.includes('\n')) return null;
  for (const sep of [',', '\t']) {
    if (!t.split('\n')[0].includes(sep)) continue;
    const rows = parseGrid(t, sep);
    if (!rows || rows.length < 3 || rows[0].length < 2 || rows.some(r => r.length !== rows[0].length)) continue;
    if (rows[0].some(h => !h.trim() || h.length > 40)) continue;
    const cell = (s: string) => s.replace(/\s*\n\s*/g, ' ').trim().replace(/\|/g, '\\|');
    const line = (r: string[]) => `| ${r.map(cell).join(' | ')} |`;
    return [line(rows[0]), `| ${rows[0].map(() => '---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n');
  }
  return null;
}

/** Your own message with any markdown table drawn as a table. Null when there is none, so the caller keeps plain text. */
export function userTables(text: string): string | null {
  if (!/^\s*\|.*\|\s*\n\s*\|?\s*:?-{2,}/m.test(text)) return null;
  const html = tables(esc(text));
  return html.includes('<table>') ? html : null;
}

/** Every path `md` would consider linking, so the caller can check which exist before rendering. */
export function fileRefs(src: string): string[] {
  const seen = new Set<string>();
  md(src, p => { seen.add(p); return false; });
  return [...seen];
}
export { esc };
