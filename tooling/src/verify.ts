// Orchestration: extension check → flatten → (parse short-circuit | composite +
// validate) → structured Result. A `.techspec.yaml` takes the same road with its
// own phase-2 rules (`techspec.ts`) in place of composite + validate.

import type { Finding, ParseError, Result } from "./types.ts";
import type { RenderKind } from "./render.ts";
import { compareFindings } from "./render.ts";
import { flatten } from "./flatten.ts";
import { resolveComposite } from "./composite.ts";
import { validate } from "./validate.ts";
import { consumersOf } from "./impact.ts";
import { listSpecs } from "./systems.ts";
import { TECHSPEC_EXT, validateTechspec } from "./techspec.ts";
import { ADR_EXT, validateAdr } from "./adr.ts";

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
function dirname(p: string): string {
  const slash = p.lastIndexOf("/");
  return slash < 0 ? "" : p.slice(0, slash);
}

/** The parse-phase short-circuit, shared by both file kinds. */
function parseFailure(file: string, parseErrors: ParseError[]): VerifyOutput {
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

/** An ADR: flatten, then the E8xx rules, resolving references in its directory. */
function verifyAdrText(file: string, text: string): VerifyOutput {
  const { records, parseErrors } = flatten(text);
  if (parseErrors.length > 0) return parseFailure(file, parseErrors);
  const { findings, summary } = validateAdr(file, records);
  const errors = [...findings].sort(compareFindings);
  return {
    kind: "normal",
    exitCode: errors.length > 0 ? 1 : 0,
    result: { file, valid: errors.length === 0, errors, warnings: [], summary },
  };
}

/** A tech spec: flatten, then the E7xx rules against the specs it lists. */
function verifyTechspecText(file: string, text: string): VerifyOutput {
  const { records, parseErrors } = flatten(text);
  if (parseErrors.length > 0) return parseFailure(file, parseErrors);
  const { findings, summary } = validateTechspec(file, records);
  const errors = [...findings].sort(compareFindings);
  return {
    kind: "normal",
    exitCode: errors.length > 0 ? 1 : 0,
    result: { file, valid: errors.length === 0, errors, warnings: [], summary },
  };
}

/** Verify a file whose text has already been read. */
export function verifyText(file: string, text: string): VerifyOutput {
  const base = basename(file);

  // The extension picks the format: a tech spec has its own rules (E7xx).
  if (base.endsWith(TECHSPEC_EXT)) return verifyTechspecText(file, text);
  if (base.endsWith(ADR_EXT)) return verifyAdrText(file, text);

  // E001: extension check.
  if (!base.endsWith(".yamlet.yaml")) {
    const e: Finding = {
      rule: "E001",
      severity: "error",
      line: 0,
      path: file,
      message: "file must use the .yamlet.yaml, " + TECHSPEC_EXT + " or " + ADR_EXT +
        " extension, got: " + base,
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
  if (parseErrors.length > 0) return parseFailure(file, parseErrors);

  // Composite member resolution + Phase 2 validate.
  const composite = resolveComposite(file, text, records);
  const { findings, summary } = validate(records, composite, dirname(file));

  // ── W008: a trusted caller claimed but never named ──
  // `internal` says "a component we deploy and control calls me"; the only place
  // yamlet names that caller is a composite wiring this spec as a member. The
  // lookup is reverse (who names *me*?), so it scans the working directory, as
  // `yamlet impact` does — a consumer outside that tree is one this cannot see.
  // A warning, not an error: leaves are written before the composite that wires
  // them, and a root may stay internal until its entry point is specified.
  const front = records.find((r) => r.path === "front");
  if (front?.value === "internal" && consumersOf(file, listSpecs(".")).length === 0) {
    findings.push({
      rule: "W008",
      severity: "warning",
      line: front.line,
      path: "front",
      message: "front=internal but no composite under the working directory wires this " +
        "spec as a member: the trusted caller it claims is unnamed",
    });
  }

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
