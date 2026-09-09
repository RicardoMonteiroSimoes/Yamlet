// Scalar quoting for the constrained YAML subset — the one rule shared by every
// serializer (author, tech spec, decision record) and by the parser's unquote.
//
// The files yamlet writes are read by yamlet's own parser, but they are also
// opened by editors, linters and every other YAML implementation, so a plain
// scalar must mean the same thing to all of them. A value is written bare only
// when YAML 1.1 and 1.2 both read it back as exactly that string; otherwise it
// is quoted. Over-quoting is harmless (the parser strips it); under-quoting is
// the bug this module exists to prevent — `note: Missing: no export path` is a
// mapping to any real parser, `*not* implemented` an alias, `1234567` a number.

/** A leading character YAML reserves as an indicator, or that starts a quoted / flow / block form. */
const LEADING_INDICATOR = /^[-?:,[\]{}#&*!|>'"%@`]/;
/** Words YAML 1.1 (and, for the first five, 1.2) reads as a boolean or null. */
const KEYWORD = /^(true|false|yes|no|null|~|on|off|y|n)$/i;
/** Numbers in every notation a YAML 1.1 loader resolves, incl. sexagesimal and `_` separators. */
const NUMBER = new RegExp(
  "^[-+]?(" +
    "(\\.[0-9]+|[0-9][0-9_]*(\\.[0-9_]*)?)([eE][-+]?[0-9]+)?" + // 12, 1_000, .5, 1.5e3
    "|0x[0-9a-fA-F_]+|0o?[0-7_]+|0b[01_]+" + // hex, octal, binary
    "|[0-9][0-9_]*(:[0-5]?[0-9])+(\\.[0-9_]*)?" + // 1:30 sexagesimal
    "|\\.(inf|Inf|INF)" +
    ")$|^\\.(nan|NaN|NAN)$",
);
/** Timestamps: a loader turns `2026-09-09` into a date object. */
const TIMESTAMP = /^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}([Tt ]\s*[0-9]|$)/;

/** True when writing `s` bare would make a standard YAML parser read something other than `s`. */
export function needsQuotes(s: string): boolean {
  if (s === "") return true;
  if (LEADING_INDICATOR.test(s)) return true;
  if (/^\s|\s$/.test(s)) return true;
  if (s.includes(": ") || s.endsWith(":") || s.includes(" #")) return true;
  return KEYWORD.test(s) || NUMBER.test(s) || TIMESTAMP.test(s);
}

/**
 * `s` as a YAML scalar that every parser reads back as `s`: bare when that is
 * safe, else double-quoted, or single-quoted (with `'` doubled) when the text
 * itself holds a `"` or a `\` — the parser's unquote does no backslash
 * processing, and single quotes need none.
 */
export function quote(s: string): string {
  if (!needsQuotes(s)) return s;
  if (s.includes('"') || s.includes("\\")) return "'" + s.replaceAll("'", "''") + "'";
  return `"${s}"`;
}

/** Whether a raw value is one of the two quoted forms `quote` emits. */
export function isQuoted(s: string): boolean {
  return s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0];
}

/** Inverse of `quote` for a raw value that `isQuoted`; anything else is returned as is. */
export function unquote(s: string): string {
  if (!isQuoted(s)) return s;
  const inner = s.slice(1, -1);
  return s[0] === "'" ? inner.replaceAll("''", "'") : inner;
}
