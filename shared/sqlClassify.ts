// One MySQL tokenizer behind everything the SQL view decides about a statement: where statements start and end,
// whether one is a read, whether it already has a top-level LIMIT, and where an error points.
// Strings, backtick identifiers and comments are skipped; /*! ... */ executable comments are read as code, because MySQL runs them.

export interface Token { type: 'word' | 'ident' | 'str' | 'num' | 'var' | 'punct'; value: string; start: number; end: number; depth: number }
export interface Statement { start: number; end: number; text: string }

export function tokenize(sql: string): Token[] {
  const out: Token[] = [];
  let i = 0, depth = 0, execComment = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i], d = sql[i + 1];
    if (/\s/.test(c)) { i++; continue; }
    // Closing an executable comment: the */ is not code, what came before it was.
    if (execComment && c === '*' && d === '/') { execComment--; i += 2; continue; }
    if (c === '/' && d === '*') {
      if (sql[i + 2] === '!' || sql[i + 2] === '+') {
        // /*!50001 SELECT */ and optimizer hints: skip the marker and the version, tokenize the rest.
        i += 3; while (i < n && /\d/.test(sql[i])) i++;
        execComment++; continue;
      }
      const close = sql.indexOf('*/', i + 2);
      i = close < 0 ? n : close + 2; continue;
    }
    if (c === '#' || (c === '-' && d === '-' && (i + 2 >= n || /\s/.test(sql[i + 2])))) {
      const nl = sql.indexOf('\n', i);
      i = nl < 0 ? n : nl + 1; continue;
    }
    const start = i;
    if (c === "'" || c === '"' || c === '`') {
      i++;
      while (i < n) {
        if (sql[i] === '\\' && c !== '`') { i += 2; continue; }
        if (sql[i] === c) { if (sql[i + 1] === c) { i += 2; continue; } i++; break; }
        i++;
      }
      out.push({ type: c === '`' ? 'ident' : 'str', value: sql.slice(start, i), start, end: i, depth });
      continue;
    }
    if (c === '@') {
      i++; while (i < n && /[\w@$.`'"]/.test(sql[i])) i++;
      out.push({ type: 'var', value: sql.slice(start, i), start, end: i, depth }); continue;
    }
    if (/\d/.test(c) || (c === '.' && d && /\d/.test(d))) {
      while (i < n && /[\w.]/.test(sql[i])) i++;
      out.push({ type: 'num', value: sql.slice(start, i), start, end: i, depth }); continue;
    }
    if (/[\p{L}_$]/u.test(c)) {
      while (i < n && /[\p{L}\p{N}_$]/u.test(sql[i])) i++;
      out.push({ type: 'word', value: sql.slice(start, i).toUpperCase(), start, end: i, depth }); continue;
    }
    if (c === '(') { out.push({ type: 'punct', value: c, start, end: i + 1, depth }); depth++; i++; continue; }
    if (c === ')') { depth = Math.max(0, depth - 1); out.push({ type: 'punct', value: c, start, end: i + 1, depth }); i++; continue; }
    out.push({ type: 'punct', value: c, start, end: i + 1, depth }); i++;
  }
  return out;
}

// An empty line between two tokens, ignoring what block comments in that gap hold.
const BLANK_LINE = /\n[ \t]*\r?\n/;
const hasBlankLine = (gap: string) => BLANK_LINE.test(gap.replace(/\/\*[\s\S]*?\*\//g, ' '));

/** Statements split on semicolons outside strings and comments, and, as in DBeaver, on a blank line outside parentheses,
 *  so a script of queries separated by empty lines needs no semicolons. `blankLines: false` splits on semicolons only (a selection is one query).
 *  Each range covers the statement's own tokens, comments around it excluded. */
export function split(sql: string, opts: { blankLines?: boolean } = {}): Statement[] {
  const blankLines = opts.blankLines !== false;
  const out: Statement[] = [];
  let first: Token | null = null, last: Token | null = null;
  const flush = () => { if (first && last) out.push({ start: first.start, end: last.end, text: sql.slice(first.start, last.end) }); first = last = null; };
  for (const t of tokenize(sql)) {
    if (t.type === 'punct' && t.value === ';') { flush(); continue; }
    if (blankLines && last && t.depth === 0 && last.depth === 0 && !(last.type === 'punct' && last.value === '(') && hasBlankLine(sql.slice(last.end, t.start))) flush();
    if (!first) first = t;
    last = t;
  }
  flush();
  return out;
}

/** The statement the cursor is in, or the nearest one before it (DBeaver's Ctrl+Enter); the first one when the cursor is above them all. */
export function statementAt(sql: string, cursor: number): Statement | null {
  const all = split(sql);
  if (!all.length) return null;
  const inside = all.find(s => cursor >= s.start && cursor <= s.end + 1);
  if (inside) return inside;
  const before = all.filter(s => s.start <= cursor);
  return before[before.length - 1] || all[0];
}

const READ_STARTS = new Set(['SELECT', 'WITH', 'SHOW', 'EXPLAIN', 'DESCRIBE', 'DESC']);
// Words that make a statement a write wherever they appear. The ones that are also function names (INSERT(), REPLACE(), TRUNCATE())
// only count when no "(" follows.
const WRITES = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'MERGE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'RENAME', 'GRANT', 'REVOKE',
  'CALL', 'HANDLER', 'LOAD', 'LOAD_FILE', 'INTO', 'OUTFILE', 'DUMPFILE', 'LOCK', 'UNLOCK', 'KILL', 'FLUSH', 'PURGE', 'INSTALL', 'UNINSTALL',
  'PREPARE', 'EXECUTE', 'DEALLOCATE', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'XA', 'USE']);
const FUNCTIONS = new Set(['INSERT', 'REPLACE', 'TRUNCATE']);

export interface Classified { ok: boolean; kind: string; reason?: string }

/** Read or not. Only SELECT, WITH ... SELECT, SHOW, EXPLAIN and DESCRIBE pass, and none of them may write, lock, or export. */
export function classify(stmt: string): Classified {
  const toks = tokenize(stmt);
  if (toks.some(t => t.type === 'punct' && t.value === ';')) return { ok: false, kind: '', reason: 'One statement at a time.' };
  let at = 0;
  while (toks[at]?.type === 'punct' && toks[at].value === '(') at++;
  const head = toks[at];
  if (!head) return { ok: false, kind: '', reason: 'Nothing to run.' };
  const kind = head.type === 'word' ? head.value : head.value.slice(0, 20);
  if (head.type !== 'word' || !READ_STARTS.has(head.value) || (at > 0 && head.value !== 'SELECT' && head.value !== 'WITH'))
    return { ok: false, kind, reason: `${kind || 'This'} is not a read. This connection runs SELECT, WITH, SHOW, EXPLAIN and DESCRIBE only.` };
  // SHOW and DESCRIBE cannot write, and SHOW CREATE TABLE or SHOW CHARACTER SET contain write words.
  if (head.value === 'SHOW' || head.value === 'DESCRIBE' || head.value === 'DESC') return { ok: true, kind };
  for (let i = at + 1; i < toks.length; i++) {
    const t = toks[i];
    if (t.type !== 'word') continue;
    const next = toks[i + 1];
    if (WRITES.has(t.value) && !(FUNCTIONS.has(t.value) && next?.type === 'punct' && next.value === '('))
      return { ok: false, kind, reason: `${t.value} is not allowed: this connection is read-only.` };
    if (t.value === 'FOR' && next?.type === 'word' && (next.value === 'UPDATE' || next.value === 'SHARE'))
      return { ok: false, kind, reason: `FOR ${next.value} takes locks; this connection is read-only.` };
  }
  return { ok: true, kind };
}

// Transaction control: each run may land on a different pooled connection and every statement commits on its own,
// so a BEGIN in one run and a COMMIT in the next would not be the same transaction.
const TX = new Set(['BEGIN', 'START', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'XA', 'LOCK', 'UNLOCK']);

export interface WriteClassified extends Classified { write: boolean; danger: string | null }

/** For a connection that may write (dev): any one statement except transaction control. `write` says whether it changes anything;
 *  `danger` names the ones worth a second look before they run: UPDATE or DELETE with no WHERE, TRUNCATE, DROP. */
export function classifyWrite(stmt: string): WriteClassified {
  const toks = tokenize(stmt);
  if (toks.some(t => t.type === 'punct' && t.value === ';')) return { ok: false, kind: '', reason: 'One statement at a time.', write: false, danger: null };
  const words = toks.filter(t => t.type === 'word');
  const head = toks.find(t => !(t.type === 'punct' && t.value === '('));
  if (!head) return { ok: false, kind: '', reason: 'Nothing to run.', write: false, danger: null };
  const kind = head.type === 'word' ? head.value : head.value.slice(0, 20);
  if (TX.has(kind) || (kind === 'SET' && words[1] && ['AUTOCOMMIT', 'TRANSACTION'].includes(words[1].value)) || (kind === 'SET' && words.some(w => w.value === 'AUTOCOMMIT')))
    return { ok: false, kind, reason: `${kind} is not supported here: every statement commits on its own, and the next run may use another connection. Run the statements one by one.`, write: true, danger: null };
  const read = classify(stmt);
  if (read.ok) return { ok: true, kind, write: false, danger: null };
  const top = (w: string) => toks.some(t => t.type === 'word' && t.value === w && t.depth === 0);
  let danger: string | null = null;
  if (kind === 'TRUNCATE') danger = 'TRUNCATE empties the whole table.';
  else if (kind === 'DROP') danger = `DROP ${words[1]?.value || ''} removes it for good.`.replace('  ', ' ');
  else if ((top('DELETE') || top('UPDATE')) && !top('WHERE')) danger = `${top('DELETE') ? 'DELETE' : 'UPDATE'} without a WHERE changes every row in the table.`;
  return { ok: true, kind, write: true, danger };
}

/** True when the statement already has a LIMIT outside any parentheses. */
export function hasTopLevelLimit(stmt: string): boolean {
  return tokenize(stmt).some(t => t.type === 'word' && t.value === 'LIMIT' && t.depth === 0);
}

/** Statements the auto-limit applies to: plain reads that return rows, not SHOW or EXPLAIN. */
export function limitable(stmt: string): boolean {
  const toks = tokenize(stmt);
  const head = toks.find(t => !(t.type === 'punct' && t.value === '('));
  return !!head && head.type === 'word' && (head.value === 'SELECT' || head.value === 'WITH') && !hasTopLevelLimit(stmt);
}

/** Appends a LIMIT on its own line, so a trailing -- comment cannot swallow it. */
export function withLimit(stmt: string, limit: number): string { return `${stmt}\nLIMIT ${limit}`; }

/** MySQL says "near '<fragment>' at line N". The fragment's offset in the statement when it appears once from that line on, else just the line. */
export function errorOffset(stmt: string, message: string): { line: number | null; offset: number | null; length: number } {
  const m = /near '([\s\S]*?)' at line (\d+)/.exec(message);
  if (!m) return { line: null, offset: null, length: 0 };
  const line = Number(m[2]);
  // MySQL cuts the fragment at 80 characters and the error itself may come from an appended LIMIT; match on its first line only.
  const frag = m[1].split('\n')[0].slice(0, 60);
  let lineStart = 0;
  for (let l = 1; l < line; l++) { const nl = stmt.indexOf('\n', lineStart); if (nl < 0) break; lineStart = nl + 1; }
  if (!frag) return { line, offset: null, length: 0 };
  const at = stmt.indexOf(frag, lineStart);
  if (at < 0 || stmt.indexOf(frag, at + 1) >= 0) return { line, offset: null, length: 0 };
  const word = /^\S+/.exec(frag)?.[0] || frag;
  return { line, offset: at, length: word.length };
}
