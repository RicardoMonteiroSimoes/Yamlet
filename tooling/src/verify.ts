// Orchestration: extension check → flatten → (parse short-circuit | composite +
// validate) → structured Result.

import type { Finding, Result } from "./types.ts";
import type { RenderKind } from "./render.ts";
import { compareFindings } from "./render.ts";
import { flatten } from "./flatten.ts";
import { resolveComposite } from "./composite.ts";
import { validate } from "./validate.ts";

export interface VerifyOutput {
  result: Result;
  kind: RenderKind;
  /** Process exit code: 0 valid, 1 invalid. */
  exitCode: 0 | 1;
}

function basename(p: string): string {
  const slash = p.lastIndexOf("/");
  return slash < 0 ? p : p.slice(slash + 1);
}

/** Verify a file whose text has already been read. */
export function verifyText(file: string, text: string): VerifyOutput {
  const base = basename(file);

  // E001: extension check.
  if (!base.endsWith(".yamlet.yaml")) {
    const e: Finding = {
      rule: "E001",
      severity: "error",
      line: 0,
      path: file,
      message: "file must use the .yamlet.yaml extension, got: " + base,
    };
    return {
      kind: "extension",
      exitCode: 1,
      result: {
        file,
        valid: false,
        errors: [e],
        warnings: [],
        summary: { requirements: 0, acceptanceCriteria: 0 },
      },
    };
  }

  // Phase 1: flatten.
  const { records, parseErrors } = flatten(text);

  // Parse-phase short-circuit.
  if (parseErrors.length > 0) {
    const errors: Finding[] = parseErrors.map((pe) => ({
      rule: pe.rule,
      severity: "error",
      line: pe.line,
      path: "",
      message: pe.message,
    }));
    return {
      kind: "parse",
      exitCode: 1,
      result: {
        file,
        valid: false,
        errors,
        warnings: [],
        summary: { requirements: 0, acceptanceCriteria: 0 },
      },
    };
  }

  // Composite member resolution + Phase 2 validate.
  const composite = resolveComposite(file, text, records);
  const { findings, summary } = validate(records, composite);

  const sorted = [...findings].sort(compareFindings);
  const errors = sorted.filter((f) => f.severity === "error");
  const warnings = sorted.filter((f) => f.severity === "warning");

  return {
    kind: "normal",
    exitCode: errors.length > 0 ? 1 : 0,
    result: {
      file,
      valid: errors.length === 0,
      errors,
      warnings,
      summary,
    },
  };
}

/** Read and verify a file from disk. Throws if the file cannot be read. */
export function verifyFile(file: string): VerifyOutput {
  const text = Deno.readTextFileSync(file);
  return verifyText(file, text);
}
