// The one scalar emitter every writer uses (spec author, tech spec, ADR), and
// the matching reader the flattener uses for a double-quoted scalar.
//
// The files are meant to be standard YAML, not just yamlet's constrained
// subset: agents, editors and other parsers read them too. So a value is left
// plain only when a standard YAML parser would read it back as that same
// string. Anything else — an embedded `: ` (which turns a list item into a
// mapping), a leading indicator, a ` #` (a comment), a word a YAML 1.1/1.2
// parser resolves to a bool, null, number or timestamp — is double-quoted,
// with `\` and `"` escaped, and `readQuoted` undoes exactly that.

/** A plain scalar starting with one of these is not a plain string. */
const LEADING_INDICATOR = /^[!&*|>'"%@`{}[\],#]/;
/** `-`, `?`, `:` start a plain scalar only when followed by a non-space. */
const LEADING_DASHLIKE = /^[-?:](?: |$)/;
const NULL = /^(?:~|null|Null|NULL)$/;
/** YAML 1.2 core booleans plus the YAML 1.1 words PyYAML still resolves. */
const BOOL =
  /^(?:y|Y|yes|Yes|YES|n|N|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$/;
const NUMBER = new RegExp(
  "^(?:" + [
    "[-+]?(?:[0-9][0-9_]*(?:\\.[0-9_]*)?|\\.[0-9_]+)(?:[eE][-+]?[0-9]+)?", // int / float
    "[-+]?0(?:b[01_]+|o?[0-7_]+|x[0-9a-fA-F_]+)", // binary / octal / hex
    "[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+(?:\\.[0-9_]*)?", // YAML 1.1 sexagesimal
    "[-+]?\\.(?:inf|Inf|INF)",
    "\\.(?:nan|NaN|NAN)",
  ].join("|") + ")$",
);
const TIMESTAMP =
  /^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}(?:(?:[Tt]|[ \t]+)[0-9]{1,2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9]{1,2}(?::[0-9]{2})?))?)?$/;
// deno-lint-ignore no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/;
/** What a double-quoted scalar must escape: the quote, the backslash, control characters. */
// deno-lint-ignore no-control-regex
const TO_ESCAPE = /[\\"\x00-\x1f\x7f]/g;

/** True when a standard YAML parser would not read `s`, written plain, as the string `s`. */
export function needsQuote(s: string): boolean {
  return s === "" ||
    s !== s.trim() ||
    LEADING_INDICATOR.test(s) ||
    LEADING_DASHLIKE.test(s) ||
    s.includes(": ") ||
    s.endsWith(":") ||
    s.includes(" #") ||
    CONTROL.test(s) ||
    NULL.test(s) ||
    BOOL.test(s) ||
    NUMBER.test(s) ||
    TIMESTAMP.test(s) ||
    s === "=";
}

const ESCAPE_OUT: Record<string, string> = {
  "\\": "\\\\",
  '"': '\\"',
  "\t": "\\t",
  "\n": "\\n",
  "\r": "\\r",
};

/** `s` as a YAML scalar: plain when that reads back as `s`, else double-quoted and escaped. */
export function scalar(s: string): string {
  if (!needsQuote(s)) return s;
  const body = s.replace(
    TO_ESCAPE,
    (c) => ESCAPE_OUT[c] ?? "\\x" + c.charCodeAt(0).toString(16).padStart(2, "0"),
  );
  return `"${body}"`;
}

const ESCAPE_IN: Record<string, string> = {
  "0": "\0",
  a: "\x07",
  b: "\b",
  t: "\t",
  "\t": "\t",
  n: "\n",
  v: "\v",
  f: "\f",
  r: "\r",
  e: "\x1b",
  " ": " ",
  '"': '"',
  "/": "/",
  "\\": "\\",
  N: "\x85",
  _: "\xa0",
  L: " ",
  P: " ",
};
const HEX_LEN: Record<string, number> = { x: 2, u: 4, U: 8 };

/**
 * The value of the double-quoted scalar `s` starts with (`s[0]` is `"`): YAML
 * escapes decoded, read up to the closing quote; anything after it (a trailing
 * comment) is not part of the value. Lenient where YAML would error: an
 * unknown escape stays literal, and an unterminated scalar runs to the end.
 */
export function readQuoted(s: string): string {
  let out = "";
  for (let i = 1; i < s.length; i++) {
    const c = s[i]!;
    if (c === '"') return out;
    if (c !== "\\" || i + 1 >= s.length) {
      out += c;
      continue;
    }
    const e = s[i + 1]!;
    const n = HEX_LEN[e];
    if (n !== undefined) {
      const hex = s.slice(i + 2, i + 2 + n);
      if (hex.length === n && /^[0-9a-fA-F]+$/.test(hex)) {
        out += String.fromCodePoint(parseInt(hex, 16));
        i += 1 + n;
        continue;
      }
    } else if (e in ESCAPE_IN) {
      out += ESCAPE_IN[e];
      i++;
      continue;
    }
    out += c; // unknown escape: keep the backslash, the next char follows as-is
  }
  return out;
}
