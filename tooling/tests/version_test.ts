import { assertEquals } from "jsr:@std/assert@1";
import { COMMANDS, versionFor } from "../main.ts";
import { helpFor } from "../src/help.ts";
import { VERSION } from "../src/version.ts";

// The version surface has two halves: `versionFor` resolves the `--version`/`-V`
// *flag* forms before dispatch (they can't be registry keys, like `-h`/`--help`),
// while the bare `version` word is a registered Command so it flows through the
// same help/dispatch machinery as everything else. These tests pin both halves,
// and — importantly — that `--help` still wins for `version` (the thing three
// reviewers flagged when `version` was special-cased outside the registry).
// VERSION is imported, not hardcoded, so the build-stamped value never couples.

const versionCmd = COMMANDS.find((c) => c.name === "version");

Deno.test("`--version` and `-V` flags resolve to the version, exit 0", () => {
  for (const cmd of ["--version", "-V"]) {
    const r = versionFor(cmd);
    if (!r) throw new Error(`${cmd} should resolve to version`);
    assertEquals(r.exitCode, 0);
    assertEquals(r.stderr, "");
    assertEquals(r.stdout, `yamlet ${VERSION}\n`);
  }
});

Deno.test("`versionFor` ignores the bare `version` word (it is a command, not a flag)", () => {
  // `version` must fall through to dispatch, not be short-circuited here.
  assertEquals(versionFor("version"), null);
  assertEquals(versionFor("verify"), null);
  assertEquals(versionFor(undefined), null);
});

Deno.test("`version` is a registered command whose runner prints the version", () => {
  if (!versionCmd) throw new Error("version must be a registered command");
  const r = versionCmd.run([]);
  assertEquals(r.exitCode, 0);
  assertEquals(r.stderr, "");
  assertEquals(r.stdout, `yamlet ${VERSION}\n`);
});

Deno.test("help wins for `version`: `version --help` and `help version` show its help", () => {
  assertEquals(helpFor(COMMANDS, "version", ["--help"])?.stdout.includes("yamlet version —"), true);
  assertEquals(helpFor(COMMANDS, "version", ["-h"])?.stdout.includes("yamlet version —"), true);
  assertEquals(helpFor(COMMANDS, "help", ["version"])?.stdout.includes("yamlet version —"), true);
});
