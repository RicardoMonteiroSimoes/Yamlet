// Regression suite: the verifier must still reproduce the frozen oracle goldens
// (tests/oracle/*.json) for every fixture. The sh+awk reference was retired, so
// the oracle is now a snapshot of this verifier's own deterministic output —
// re-freeze it with `deno run --allow-read --allow-write tests/gen-oracle.ts`
// after an intentional rule change, review the reported diffs, and commit.
// Compared: valid flag, summary, exit code, and the finding set (canonicalized
// by sorting on line/rule/severity/path/message).

import { assertEquals } from "jsr:@std/assert@1";
import { verifyFile } from "../src/verify.ts";
import type { Finding } from "../src/types.ts";

const testDir = new URL(".", import.meta.url).pathname;
const oracleDir = testDir + "oracle";
const fixturesDir = testDir + "verifier-fixtures";

// Oracle goldens were captured with CWD = fixtures dir and bare basenames, so
// composite member paths resolve relative to ".". Match that here.
Deno.chdir(fixturesDir);

interface OracleJson {
  file: string;
  valid: boolean;
  errors: Finding[];
  warnings: Finding[];
  summary: { requirements: number; acceptanceCriteria: number };
}

function canonFindings(errors: Finding[], warnings: Finding[]): string[] {
  return [...errors, ...warnings]
    .map((f) => [f.line, f.rule, f.severity, f.path, f.message].join(" "))
    .sort();
}

const manifest = Deno.readTextFileSync(oracleDir + "/manifest.tsv")
  .split("\n")
  .filter((l) => l.trim() !== "")
  .map((l) => {
    const [name, code] = l.split("\t");
    return { name: name!, exit: Number(code) };
  });

for (const { name, exit } of manifest) {
  Deno.test(`parity: ${name}`, () => {
    const oracle: OracleJson = JSON.parse(Deno.readTextFileSync(`${oracleDir}/${name}.json`));
    const { result, exitCode } = verifyFile(name);

    assertEquals(exitCode, exit, `exit code for ${name}`);
    assertEquals(result.valid, oracle.valid, `valid flag for ${name}`);
    assertEquals(result.summary, oracle.summary, `summary for ${name}`);
    assertEquals(
      canonFindings(result.errors, result.warnings),
      canonFindings(oracle.errors, oracle.warnings),
      `findings for ${name}`,
    );
  });
}
