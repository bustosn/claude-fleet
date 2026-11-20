import type { Extension } from '@codemirror/state';
import { LanguageSupport } from '@codemirror/language';
import { styleTags, tags as t } from '@lezer/highlight';
import { parseMixed } from '@lezer/common';

/**
 * PHP as the package builds it, with one added rule: the stock grammar gives `$x->get()` and `Foo::get()` the same tag,
 * and a static call is shown differently (italic) in PhpStorm.
 */
async function phpWithStatics(): Promise<Extension> {
  const [{ phpLanguage }, { html }] = await Promise.all([import('@codemirror/lang-php'), import('@codemirror/lang-html')]);
  const base = html({ matchClosingTags: false });
  return new LanguageSupport(phpLanguage.configure({
    props: [styleTags({ 'CallExpression/ScopedExpression/ClassMemberName/Name': t.special(t.function(t.propertyName)) })],
    wrap: parseMixed(node => (node.type.isTop ? { parser: base.language.parser, overlay: n => n.name === 'Text' } : null)),
    top: 'Template',
  }), [base.support]);
}

// Language support is loaded the first time a file of that kind opens, so the packs stay out of the main bundle.
const byExt: Record<string, () => Promise<Extension>> = {
  php: phpWithStatics,
  phtml: phpWithStatics,
  js: () => import('@codemirror/lang-javascript').then(m => m.javascript()),
  mjs: () => import('@codemirror/lang-javascript').then(m => m.javascript()),
  cjs: () => import('@codemirror/lang-javascript').then(m => m.javascript()),
  jsx: () => import('@codemirror/lang-javascript').then(m => m.javascript({ jsx: true })),
  ts: () => import('@codemirror/lang-javascript').then(m => m.javascript({ typescript: true })),
  tsx: () => import('@codemirror/lang-javascript').then(m => m.javascript({ typescript: true, jsx: true })),
  py: () => import('@codemirror/lang-python').then(m => m.python()),
  json: () => import('@codemirror/lang-json').then(m => m.json()),
  html: () => import('@codemirror/lang-html').then(m => m.html()),
  htm: () => import('@codemirror/lang-html').then(m => m.html()),
  vue: () => import('@codemirror/lang-html').then(m => m.html()),
  css: () => import('@codemirror/lang-css').then(m => m.css()),
  scss: () => import('@codemirror/lang-css').then(m => m.css()),
  md: () => import('@codemirror/lang-markdown').then(m => m.markdown()),
  yml: () => import('@codemirror/lang-yaml').then(m => m.yaml()),
  yaml: () => import('@codemirror/lang-yaml').then(m => m.yaml()),
  xml: () => import('@codemirror/lang-xml').then(m => m.xml()),
  svg: () => import('@codemirror/lang-xml').then(m => m.xml()),
  sql: () => import('@codemirror/lang-sql').then(m => m.sql()),
};
// Files with no extension, or a name that says what they are.
const byName: Record<string, string> = { '.env': '', 'composer.lock': 'json', '.babelrc': 'json', '.eslintrc': 'json' };

const names: Record<string, string> = {
  php: 'PHP', phtml: 'PHP', js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JSX', ts: 'TypeScript', tsx: 'TSX', py: 'Python',
  json: 'JSON', html: 'HTML', htm: 'HTML', vue: 'Vue', css: 'CSS', scss: 'SCSS', md: 'Markdown', yml: 'YAML', yaml: 'YAML', xml: 'XML', svg: 'SVG', sql: 'SQL',
  sh: 'Shell', bash: 'Shell', ps1: 'PowerShell', txt: 'Plain text', env: 'Env',
};

function extOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  if (base in byName) return byName[base];
  const i = base.lastIndexOf('.');
  return i < 0 ? '' : base.slice(i + 1);
}

export const languageName = (path: string) => names[extOf(path)] || 'Plain text';

/** The language extension for a file, or null when there is none for it. */
export async function languageFor(path: string): Promise<Extension | null> {
  const load = byExt[extOf(path)];
  if (!load) return null;
  try { return await load(); } catch { return null; }
}
