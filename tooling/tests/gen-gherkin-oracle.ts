// Regenerate the Gherkin oracle from the canonical example specs.
//
// The oracle under `oracle-gherkin/` is a *frozen snapshot* of `yamlet tests`'
// output for the repo's `specs_example/` set. This script re-freezes it: run it
// after an intentional change to the projection (vocabulary, layout, tags) or to
// the example specs, review the reported diffs, and commit. `gherkin_test.ts`
// then guards against unintended drift.
//
//   deno run --allow-read --allow-write tests/gen-gherkin-oracle.ts

import { runTests } from "../src/tests.ts";

const specsAbs = new URL("../../specs_example/", import.meta.url).pathname.replace(/\/$/, "");
const oracleAbs = new URL("./oracle-gherkin/", import.meta.url).pathname.replace(/\/$/, "");

// Start clean so a removed/renamed feature can never linger as a stale golden.
try {
  Deno.removeSync(oracleAbs, { recursive: true });
} catch { /* first run */ }
Deno.mkdirSync(oracleAbs, { recursive: true });

const res = runTests([specsAbs, oracleAbs]);
if (res.exitCode !== 0) {
  console.error(res.stderr);
  Deno.exit(res.exitCode);
}
// Rewrite the absolute target prefix out of the summary so it reads portably.
console.log(res.stdout.replaceAll(oracleAbs + "/", "oracle-gherkin/"));
