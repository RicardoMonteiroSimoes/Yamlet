import { assertEquals } from "jsr:@std/assert@1";
import { helpFor, topLevelHelp } from "../src/help.ts";
import { COMMANDS } from "../main.ts";

// helpFor is the whole contract: explicit help is a success (stdout, exit 0),
// everything else returns null so normal dispatch (and its errors) proceed.
// It reads the real registry, so these tests also guard that every registered
// command is reachable and self-describing.

Deno.test("`-h` and `--help` print top-level help to stdout, exit 0", () => {
  for (const cmd of ["-h", "--help"]) {
    const r = helpFor(COMMANDS, cmd, []);
    if (!r) throw new Error(`${cmd} should resolve to help`);
    assertEquals(r.exitCode, 0);
    assertEquals(r.stderr, "");
    if (!r.stdout.includes("Usage: yamlet <command>")) {
      throw new Error(`${cmd} help missing top-level usage`);
    }
  }
});

Deno.test("`help` alone prints top-level help", () => {
  const r = helpFor(COMMANDS, "help", []);
  assertEquals(r?.stdout.includes("Commands:"), true);
  assertEquals(r?.exitCode, 0);
});

Deno.test("`help <command>` prints that command's help", () => {
  const r = helpFor(COMMANDS, "help", ["graph"]);
  assertEquals(r?.stdout.includes("yamlet graph —"), true);
});

Deno.test("`help <unknown>` falls back to top-level help", () => {
  const r = helpFor(COMMANDS, "help", ["bogus"]);
  assertEquals(r?.stdout.includes("Usage: yamlet <command>"), true);
});

Deno.test("`<command> --help` and `-h` print that command's help (flag anywhere)", () => {
  assertEquals(helpFor(COMMANDS, "verify", ["--help"])?.stdout.includes("yamlet verify —"), true);
  assertEquals(helpFor(COMMANDS, "graph", ["-h"])?.stdout.includes("yamlet graph —"), true);
  // Flag position is irrelevant; help wins over other args.
  assertEquals(
    helpFor(COMMANDS, "verify", ["x.yamlet.yaml", "--help"])?.stdout.includes("yamlet verify —"),
    true,
  );
});

Deno.test("a real short flag is not hijacked as help", () => {
  // graph's -r (recursive) must reach dispatch, not the help path.
  assertEquals(helpFor(COMMANDS, "graph", ["-r"]), null);
});

Deno.test("non-help invocations return null so dispatch proceeds", () => {
  assertEquals(helpFor(COMMANDS, "verify", ["x.yamlet.yaml"]), null);
  assertEquals(helpFor(COMMANDS, "bogus", []), null); // unknown command -> dispatch errors
  assertEquals(helpFor(COMMANDS, undefined, []), null); // no command -> dispatch errors
});

Deno.test("top-level help lists every registered command by name and summary", () => {
  const text = topLevelHelp(COMMANDS);
  for (const c of COMMANDS) {
    if (!text.includes(c.name) || !text.includes(c.summary)) {
      throw new Error(`top-level help omits "${c.name}"`);
    }
  }
});

Deno.test("every registered command is self-describing", () => {
  for (const c of COMMANDS) {
    if (!c.summary) throw new Error(`command "${c.name}" has no summary`);
    if (!c.help.includes(`yamlet ${c.name} —`)) {
      throw new Error(`command "${c.name}" is missing a self-naming help synopsis`);
    }
    if (typeof c.run !== "function") throw new Error(`command "${c.name}" has no run function`);
  }
});
