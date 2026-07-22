// yamlet CLI entry point.
//
// Usage:
//   yamlet help [command]            (or `yamlet <command> --help`)
//   yamlet verify [--format=human|json] <file.yamlet.yaml>
//   yamlet verify --list-rules [--format=human|json]
//   yamlet systems [DIR] [--format=human|json]
//   yamlet graph FILE|DIR [--format=dot|json] [--recursive]
//   yamlet init FILE ...
//   yamlet add-requirement FILE --description "..."
//   yamlet add-criterion FILE --rq RQ-N --pattern P ...
//
// Exit codes: 0 success · 1 verify found errors · 2 usage/validation · 3 mutation
// rolled back by the commit gate.
//
// Commands are a data-driven registry: each command module exports a self-
// describing descriptor (name, summary, help, run). Dispatch and `yamlet help`
// both read this one list, so neither can drift from the other.

import { CATALOG } from "./src/catalog.ts";
import { renderHuman, renderJson } from "./src/render.ts";
import { verifyFile } from "./src/verify.ts";
import {
  addComponentCommand,
  addConnectionCommand,
  addCriterionCommand,
  addRequirementCommand,
  initCommand,
} from "./src/author.ts";
import { systemsCommand } from "./src/systems.ts";
import { graphCommand } from "./src/graph.ts";
import { helpFor, USAGE } from "./src/help.ts";
import type { CmdResult, Command } from "./src/types.ts";

const enc = new TextEncoder();
const out = (s: string): void => {
  Deno.stdout.writeSync(enc.encode(s));
};
const err = (s: string): void => {
  Deno.stderr.writeSync(enc.encode(s));
};

function listRulesText(format: "human" | "json"): string {
  if (format === "json") {
    let s = "[\n";
    CATALOG.forEach((r, i) => {
      if (i > 0) s += ",\n";
      s += `  {"rule":"${r.id}","severity":"${r.severity}","description":"${r.description}"}`;
    });
    return s + "\n]\n";
  }
  let s = "";
  for (const r of CATALOG) {
    s += r.id.padEnd(6) + "  " + r.severity.padEnd(7) + "  " + r.description + "\n";
  }
  return s;
}

function isFile(p: string): boolean {
  try {
    return Deno.statSync(p).isFile;
  } catch {
    return false;
  }
}

function runVerify(args: string[]): CmdResult {
  let format: "human" | "json" = "human";
  let listRulesFlag = false;
  let file = "";

  for (const arg of args) {
    if (arg === "--format=human") format = "human";
    else if (arg === "--format=json") format = "json";
    else if (arg === "--list-rules") listRulesFlag = true;
    else if (arg.startsWith("--")) {
      return { exitCode: 2, stdout: "", stderr: "Unknown option: " + arg + "\n" + USAGE };
    } else {
      if (file !== "") return { exitCode: 2, stdout: "", stderr: "Too many arguments\n" };
      file = arg;
    }
  }

  if (listRulesFlag) return { exitCode: 0, stdout: listRulesText(format), stderr: "" };

  if (file === "") return { exitCode: 2, stdout: "", stderr: USAGE };
  if (!isFile(file)) return { exitCode: 2, stdout: "", stderr: file + ": file not found\n" };

  const { result, kind, exitCode } = verifyFile(file);

  if (format === "json") {
    return { exitCode, stdout: renderJson(result, kind), stderr: "" };
  }
  const { stderr, stdout } = renderHuman(result, kind);
  return { exitCode, stdout: stdout ?? "", stderr: stderr ?? "" };
}

const verifyCommand: Command = {
  name: "verify",
  summary: "check a spec against the rule catalog",
  help: `yamlet verify — check a spec against the rule catalog

Usage:
  yamlet verify [--format=human|json] <file.yamlet.yaml>
  yamlet verify --list-rules [--format=human|json]

Options:
  --format=human|json   output shape (default: human)
  --list-rules          print the rule catalog instead of verifying a file

Exit: 0 clean · 1 errors found · 2 usage error
`,
  run: runVerify,
};

/** The command registry — the single source of truth for dispatch and help. */
export const COMMANDS: Command[] = [
  verifyCommand,
  systemsCommand,
  graphCommand,
  initCommand,
  addComponentCommand,
  addConnectionCommand,
  addRequirementCommand,
  addCriterionCommand,
];

function emit(r: CmdResult): number {
  if (r.stdout) out(r.stdout);
  if (r.stderr) err(r.stderr);
  return r.exitCode;
}

function main(): number {
  const [cmd, ...rest] = Deno.args;

  // Explicit help requests are a success: full text to stdout, exit 0.
  const help = helpFor(COMMANDS, cmd, rest);
  if (help) return emit(help);

  if (cmd === undefined) {
    err(USAGE);
    return 2;
  }
  const command = COMMANDS.find((c) => c.name === cmd);
  if (!command) {
    err(`Unknown command: ${cmd}\n`);
    err(USAGE);
    return 2;
  }
  return emit(command.run(rest));
}

if (import.meta.main) {
  Deno.exit(main());
}
