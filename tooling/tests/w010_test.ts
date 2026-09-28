// W010: a criterion with nothing a test can bind — no {input.X}, {output.X} or
// {alias.socket} left verbatim, and no reads/writes. It fires exactly when
// `yamlet tests` gives the criterion no manifest entry.

import { assertEquals } from "jsr:@std/assert@1";
import { verifyText } from "../src/verify.ts";

/** A leaf spec exposing `recipient`, with one criterion built from `ac` lines. */
function spec(ac: string): string {
  return `system: svc\ntopic: T\nsummary: s\ndescription: >-\n  d\n` +
    `blast_radius: low\nfront: external\nexposes:\n  name: send\n  intent: send\n` +
    `  inputs:\n  - recipient\nrequirements:\n- id: RQ-1\n  description: >-\n    r\n` +
    `  acceptance-criteria:\n  - id: AC-1\n    pattern: unwanted\n` +
    `    if: "{input.recipient} is blank"\n    shall:\n    - reject the send\n` +
    `  - id: AC-2\n${ac}`;
}

function w010(text: string): string[] {
  const dir = Deno.makeTempDirSync();
  const prev = Deno.cwd();
  Deno.chdir(dir);
  try {
    return verifyText("a.yamlet.yaml", text).result.warnings
      .filter((f) => f.rule === "W010")
      .map((f) => f.path);
  } finally {
    Deno.chdir(prev);
  }
}

Deno.test("W010: a criterion with no contract token and no stored state warns", () => {
  const text = spec("    pattern: event\n    when: the day ends\n    shall:\n    - do nothing\n");
  assertEquals(w010(text), ["requirements[0].acceptance-criteria[1]"]);
});

Deno.test("W010: a contract token anywhere in the criterion binds it", () => {
  const text = spec(
    "    pattern: event\n    when: a send is requested\n    shall:\n" +
      "    - address the e-mail to {input.recipient}\n",
  );
  assertEquals(w010(text), []);
});

Deno.test("W010: a declared read or write binds it", () => {
  const reads = spec(
    "    pattern: event\n    when: the day ends\n    shall:\n    - purge old sends\n" +
      "    writes:\n    - send.sent_at\n",
  );
  assertEquals(w010(reads), []);
});

Deno.test("W010: an example-backed token is data, not a binding", () => {
  const text = spec(
    "    pattern: event\n    when: a send to {input.recipient} is requested\n    shall:\n" +
      "    - queue the send\n    examples:\n    - input.recipient: a@b.c\n",
  );
  assertEquals(w010(text), ["requirements[0].acceptance-criteria[1]"]);
});
