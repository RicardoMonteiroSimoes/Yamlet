// Core data model shared across the verifier phases.

export type Severity = "error" | "warning";

/** A single validation finding, mirroring one row of the sh verifier output. */
export interface Finding {
  rule: string;
  severity: Severity;
  line: number;
  path: string;
  message: string;
}

/** A flattened leaf record: one scalar value at a dotted/bracketed path. */
export interface FlatRecord {
  path: string;
  value: string;
  line: number;
}

/** A parse-phase error emitted by the flattener (E002/E003/E004/E006/E008/E010). */
export interface ParseError {
  rule: string;
  line: number;
  message: string;
}

export interface FlattenResult {
  records: FlatRecord[];
  parseErrors: ParseError[];
}

/** The final verification result for one file. */
export interface Result {
  file: string;
  valid: boolean;
  errors: Finding[];
  warnings: Finding[];
  summary: {
    requirements: number;
    acceptanceCriteria: number;
  };
}

/** The result of running a CLI command: the streams to write and the exit code. */
export interface CmdResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * A self-describing CLI command. Each command module owns its descriptor —
 * `name`, a one-line `summary` for `yamlet help`'s command table, the full
 * `help` synopsis for `yamlet <cmd> --help`, and its `run` function. Help then
 * aggregates the descriptors, so it can never drift from the code, and dispatch
 * is data-driven from the registry rather than a hand-maintained switch.
 */
export interface Command {
  name: string;
  summary: string;
  help: string;
  run: (args: string[]) => CmdResult;
}
