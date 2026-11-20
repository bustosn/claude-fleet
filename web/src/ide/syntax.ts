import { HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

// The IDE's code colors, after PhpStorm's dark scheme: variables, properties and constants purple; classes, types and other names orange;
// keywords salmon; methods and functions blue (static calls italic); strings green; numbers teal; comments grey.
// Each is a dark value and a lighter one for the light theme. Kept apart from the SQL editor's palette (sql/SqlEditor.tsx).
const c = {
  keyword: 'light-dark(#a8480a, #cf8e6d)',
  variable: 'light-dark(#7a3fa0, #a58ed8)',
  klass: 'light-dark(#c25f0d, #f0a35e)',
  fn: 'light-dark(#1a5fb4, #56a8f5)',
  string: 'light-dark(#2f7d32, #6aab73)',
  number: 'light-dark(#0a6b8a, #2aacb8)',
  comment: 'light-dark(#7f7f7f, #7a7e85)',
  meta: 'light-dark(#8a8a00, #bbb529)',
  tag: 'light-dark(#8a6100, #e8bf6a)',
};

export const ideHighlight = HighlightStyle.define([
  // Keywords, modifiers, and the literals that read as keywords (true, false, null).
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword, t.modifier, t.self, t.null, t.bool], color: c.keyword },
  // Variables, properties and constants.
  { tag: [t.variableName, t.propertyName, t.special(t.propertyName), t.special(t.variableName), t.constant(t.variableName), t.constant(t.name), t.constant(t.propertyName), t.attributeName], color: c.variable },
  { tag: [t.constant(t.variableName), t.constant(t.name), t.constant(t.propertyName)], fontStyle: 'italic' },
  // Classes, interfaces, types, namespaces, and any other plain name (in PHP, the name after `new` or before `::`).
  { tag: [t.name, t.className, t.typeName, t.namespace, t.definition(t.className), t.definition(t.typeName), t.macroName], color: c.klass },
  // Functions and methods, where called and where declared. A static call (`Foo::bar()`) is the same blue, italic.
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.function(t.definition(t.variableName)), t.function(t.definition(t.propertyName)), t.definition(t.function(t.variableName))], color: c.fn },
  { tag: t.special(t.function(t.propertyName)), color: c.fn, fontStyle: 'italic' },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: c.string },
  { tag: [t.number, t.integer, t.float], color: c.number },
  { tag: [t.lineComment, t.blockComment, t.comment, t.docComment], color: c.comment, fontStyle: 'italic' },
  { tag: [t.meta, t.annotation, t.processingInstruction], color: c.meta },
  { tag: [t.tagName, t.angleBracket], color: c.tag },
  { tag: [t.labelName, t.escape], color: c.keyword },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket, t.derefOperator], color: 'var(--fg-muted)' },
  { tag: t.heading, color: c.keyword, fontWeight: '600' },
  { tag: t.link, color: c.number, textDecoration: 'underline' },
  { tag: t.invalid, color: 'var(--crit)' },
]);
