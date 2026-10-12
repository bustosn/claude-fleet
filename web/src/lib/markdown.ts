const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const unesc = (s: string) => s.replace(/&(amp|lt|gt|quot);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"' }[e as 'amp']));

/** A path in running text: a drive path, or something with a slash and an extension. Not inside a URL or a longer word. */
const PATH = String.raw`(?<![\w/\\:.@-])(?:[A-Za-z]:[\\/][^\s\x60<>"'|*?()\[\]&]+|(?:~|\.{1,2})?[\\/]?(?:[\w.@-]+[\\/])+[\w@-][\w.@-]*\.[A-Za-z0-9]{1,8})(?::\d+(?::\d+)?)?`;
// One pass over prose: inline code, a markdown link, or a bare path. Matching all three together keeps a link from being linked twice.
const TOKEN = new RegExp(String.raw`\x60([^\x60]+)\x60|\[([^\]\n]+)\]\(([^)\s]+)\)|(${PATH})`, 'g');
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
    if (code != null) {
      const c = `<code>${code}</code>`;
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

/** Minimal markdown for chat replies: fenced code, inline code, links, bold, bullets, paragraphs. Everything is escaped first. */
export function md(src: string, isFile?: (path: string) => boolean): string {
  const parts = src.split(/```/);
  return parts.map((p, i) => i % 2
    ? `<pre><code>${esc(p.replace(/^\w*\n/, ''))}</code></pre>`
    : linkify(esc(p), isFile)
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/^(#{1,4}) (.*)$/gm, (_, h: string, t: string) => `<h${h.length}>${t}</h${h.length}>`)
      .replace(/^(?:- |\* )(.*)$/gm, '<li>$1</li>')
      // Newlines between items or after a heading would each become a <br> and open gaps in the block.
      .replace(/(<li>.*<\/li>\n?)+/g, m => `<ul>${m.replace(/\n/g, '')}</ul>`)
      .replace(/(<\/h\d>|<\/ul>)\n+/g, '$1')
      .replace(/\n{2,}/g, '</p><p>')
      .replace(/\n/g, '<br>')).join('');
}

/** Every path `md` would consider linking, so the caller can check which exist before rendering. */
export function fileRefs(src: string): string[] {
  const seen = new Set<string>();
  md(src, p => { seen.add(p); return false; });
  return [...seen];
}
export { esc };
