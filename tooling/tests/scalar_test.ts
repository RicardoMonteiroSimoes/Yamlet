// The quoting rule shared by every serializer: a value yamlet writes bare must
// read back as the same string in yamlet's own parser AND in an independent
// YAML implementation — the files are opened by editors and other tools, not
// only by `yamlet verify`. `@std/yaml` stands in for "everyone else".

import { assertEquals } from "jsr:@std/assert@1";
import { parse } from "jsr:@std/yaml@1";
import { flatten } from "../src/flatten.ts";
import { needsQuotes, quote, unquote } from "../src/scalar.ts";

/** Values that a standard parser would misread if written bare. */
const HAZARDS = [
  "Missing: no export path exists", // `: ` makes a nested mapping
  "Ends with a colon:",
  "*not* implemented", // alias
  "&anchor text",
  "!tag text",
  "- leading dash",
  "? question",
  ": colon first",
  "[flow] sequence",
  "{flow} mapping",
  "# looks like a comment",
  "trailing #comment marker",
  "| literal indicator",
  "> folded indicator",
  "%directive",
  "@reserved",
  "`reserved",
  '"reason" must be recorded',
  'Missing: a "quoted" word and a \\ backslash', // needs quotes, and cannot be double-quoted
  "'quoted' at the edges",
  "  leading space",
  "trailing space ",
  "",
  "yes",
  "No",
  "TRUE",
  "null",
  "~",
  "on",
  "1234567", // an all-digit commit hash
  "0x1F",
  "1_000",
  "1e5", // a slug the spec's E105 accepts
  "12.5",
  ".inf",
  ".NaN",
  "1:30",
  "2026-09-09",
];

/** Values that are safe bare and must stay that way (the files should not fill with quotes). */
const PLAIN = [
  "Sends email",
  "README.md:1", // `:` not followed by a space
  "src/main/Smtp.java:12",
  "e-mail-sending-service",
  "40f0d99",
  "9f3c1ab",
  "Rejects at exactly max_size_bytes; AC-3 requires an empty error there.",
  "schedule a retry after {delay_seconds} seconds",
  "ADR-0002#R-1",
  "it's got a quote and a \\ backslash",
  "true-ish text",
  "yes please",
  "version 1.2.3",
  "2026-09-09 is the date", // not a timestamp: text follows the date
];

Deno.test("hazardous values are quoted; plain values are left bare", () => {
  for (const s of HAZARDS) assertEquals(needsQuotes(s), true, `should quote: ${JSON.stringify(s)}`);
  for (const s of PLAIN) assertEquals(quote(s), s, `should stay bare: ${JSON.stringify(s)}`);
});

Deno.test("quote round-trips through yamlet's parser and through @std/yaml alike", () => {
  for (const s of [...HAZARDS, ...PLAIN]) {
    const text = `key: ${quote(s)}\nlist:\n- ${quote(s)}\n`;

    const { records, parseErrors } = flatten(text);
    assertEquals(parseErrors, [], `yamlet rejects ${JSON.stringify(s)}`);
    const expected = s.trim(); // the parser normalises edge whitespace on every scalar
    assertEquals(records.map((r) => r.value), [expected, expected], `yamlet misreads ${text}`);

    const doc = parse(text) as { key: unknown; list: unknown[] };
    assertEquals(doc.key, s, `@std/yaml misreads ${text}`);
    assertEquals(doc.list, [s], `@std/yaml misreads ${text}`);
  }
});

Deno.test("unquote inverts both quoted forms and leaves everything else alone", () => {
  assertEquals(unquote('"a: b"'), "a: b");
  assertEquals(unquote("'it''s'"), "it's");
  assertEquals(unquote("''"), "");
  assertEquals(unquote("bare"), "bare");
  assertEquals(unquote('"'), '"'); // a lone quote is not a quoted form
  assertEquals(unquote("'mismatched\""), "'mismatched\"");
});
