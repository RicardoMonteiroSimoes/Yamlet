// Regenerate the Markdown docs oracle.
//
// `oracle-docs/` is a frozen snapshot of `yamlet docs` for two sources: the
// repo's `specs_example/` (leaves and composites) and `tests/trace-fixtures/`
// (a spec with decision records in every status, plus a tech spec that must not
// be rendered). Pages link their source files relatively, so the goldens are
// written in place and `docs_test.ts` replays them with `--check`. Re-freeze
// after an intentional change to the rendering, review the diff, and commit.
//
//   deno run --allow-read --allow-write tests/gen-docs-oracle.ts

import { runDocs } from "../src/docs.ts";

const here = (p: string) => new URL(p, import.meta.url).pathname.replace(/\/$/, "");
const SOURCES: [string, string][] = [
  [here("../../specs_example/"), here("./oracle-docs/specs_example/")],
  [here("./trace-fixtures/"), here("./oracle-docs/trace-fixtures/")],
];

for (const [src, out] of SOURCES) {
  // Start clean so a removed page can never linger as a stale golden.
  try {
    Deno.removeSync(out, { recursive: true });
  } catch { /* first run */ }
  const res = runDocs([src, out]);
  if (res.exitCode !== 0) {
    console.error(res.stderr);
    Deno.exit(res.exitCode);
  }
  console.log(res.stdout.replaceAll(here("./") + "/", ""));
}
