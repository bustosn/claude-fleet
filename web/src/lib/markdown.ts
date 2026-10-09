const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** Minimal markdown for chat replies: fenced code, inline code, bold, bullets, paragraphs. Everything is escaped first. */
export function md(src: string): string {
  const parts = src.split(/```/);
  return parts.map((p, i) => i % 2
    ? `<pre><code>${esc(p.replace(/^\w*\n/, ''))}</code></pre>`
    : esc(p)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/^(?:- |\* )(.*)$/gm, '<li>$1</li>')
      .replace(/(<li>.*<\/li>\n?)+/g, m => `<ul>${m}</ul>`)
      .replace(/\n{2,}/g, '</p><p>')
      .replace(/\n/g, '<br>')).join('');
}
export { esc };
