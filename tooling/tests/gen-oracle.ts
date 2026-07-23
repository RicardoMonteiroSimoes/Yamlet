// Regenerate the verifier oracle goldens from the TS verifier.
//
// Since the sh+awk reference was retired, the oracle is no longer an independent
// implementation — it is a *frozen snapshot* of this verifier's output. This
// script re-freezes it: run it after an intentional rule change, review the
// reported diffs, and commit. `parity_test.ts` then guards against unintended
// drift. Fixture member paths are relative, so we run from the fixtures dir.
//
//   deno run --allow-read --allow-write tests/gen-oracle.ts

import { verifyFile } from "../src/verify.ts";
import { renderJson } from "../src/render.ts";

const fixturesAbs = new URL("./verifier-fixtures/", import.meta.url).pathname;
const oracleAbs = new URL("./oracle/", import.meta.url).pathname;

Deno.chdir(fixturesAbs);

const names: string[] = [];
for (const e of Deno.readDirSync(".")) {
  if (e.isFile && e.name.endsWith(".yaml")) names.push(e.name);
}
names.sort();

const changed: string[] = [];
const manifest: string[] = [];
for (const name of names) {
  const { result, kind, exitCode } = verifyFile(name);
  const json = renderJson(result, kind);
  const target = oracleAbs + name + ".json";
  let prev = "";
  try {
    prev = Deno.readTextFileSync(target);
  } catch { /* new fixture */ }
  if (prev !== json) changed.push(prev === "" ? `${name} (new)` : name);
  Deno.writeTextFileSync(target, json);
  manifest.push(`${name}\t${exitCode}`);
}
Deno.writeTextFileSync(oracleAbs + "manifest.tsv", manifest.join("\n") + "\n");

console.log(`regenerated ${names.length} oracles`);
console.log(changed.length === 0 ? "no oracle changed" : `changed:\n  ${changed.join("\n  ")}`);
