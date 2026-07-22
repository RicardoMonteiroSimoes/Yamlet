// `yamlet help` / `--help` — a pure aggregator over the command registry.
//
// This module owns no command text. Each command module exports its own
// descriptor (name, summary, help); here we only assemble them: the top-level
// help's command table is generated from every descriptor's `summary`, and
// `helpFor` resolves a request to a command's `help`. So help can never drift
// from the code — a command that isn't registered simply doesn't appear, and
// one that is registered cannot omit its help.
//
// Help is a *success*: it goes to stdout with exit 0, so `yamlet help | less`
// works. Error paths (no command, unknown command, bad flags) stay on stderr
// with exit 2; those live in main.ts.

import type { CmdResult, Command } from "./types.ts";

/** Short one-line hint printed on usage errors (stderr). */
export const USAGE = "Usage: yamlet <command> [options]  —  run `yamlet help` for the full list\n";

const HEADER = `yamlet — verify and author yamlet specs

Usage: yamlet <command> [options]

Commands:
`;

const FOOTER = `
Run \`yamlet <command> --help\` for command-specific usage.

Exit codes:
  0  success
  1  verify found errors
  2  usage or validation error (nothing written)
  3  a mutation produced an unexpected finding and was rolled back
`;

/** Top-level help: the header, a generated command table, and the exit codes. */
export function topLevelHelp(commands: Command[]): string {
  const width = Math.max(...commands.map((c) => c.name.length));
  const rows = commands.map((c) => `  ${c.name.padEnd(width)}   ${c.summary}`).join("\n");
  return HEADER + rows + "\n" + FOOTER;
}

const ok = (stdout: string): CmdResult => ({ stdout, stderr: "", exitCode: 0 });

/**
 * Resolve an explicit help request to its output, or null to let normal
 * dispatch proceed. Handles:
 *   yamlet -h | --help | help            -> top-level help
 *   yamlet help <command>                -> that command's help
 *   yamlet <command> --help | -h         -> that command's help (flag anywhere)
 * A help flag always wins over other arguments.
 */
export function helpFor(
  commands: Command[],
  cmd: string | undefined,
  rest: string[],
): CmdResult | null {
  const byName = (name: string | undefined): Command | undefined =>
    name === undefined ? undefined : commands.find((c) => c.name === name);

  if (cmd === "-h" || cmd === "--help") return ok(topLevelHelp(commands));
  if (cmd === "help") {
    const sub = byName(rest[0]);
    return ok(sub ? sub.help : topLevelHelp(commands));
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    const self = byName(cmd);
    if (self) return ok(self.help);
  }
  return null;
}
