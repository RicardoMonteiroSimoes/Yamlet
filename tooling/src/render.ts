// Output rendering — reproduces the sh verifier's three emit paths byte-for-byte:
//   "extension" — the E001 short-circuit (single-line JSON)
//   "parse"     — parse-phase errors (multi-line JSON, inline empty warnings)
//   "normal"    — full validation (multi-line JSON, newline-wrapped arrays)

import type { Finding, Result } from "./types.ts";

export type RenderKind = "extension" | "parse" | "normal";

function jsesc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Finding order: (line asc, rule asc), then (path asc, message asc) as a
 * deterministic tie-breaker. The sh verifier sorts on (line, rule) only and
 * leaves ties in awk hash order; the extra keys make our output stable.
 */
export function compareFindings(a: Finding, b: Finding): number {
  if (a.line !== b.line) return a.line - b.line;
  if (a.rule !== b.rule) return a.rule < b.rule ? -1 : 1;
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  if (a.message !== b.message) return a.message < b.message ? -1 : 1;
  return 0;
}

function entry(f: Finding): string {
  return `{"rule":"${f.rule}","severity":"${f.severity}","line":${f.line},"path":"${
    jsesc(f.path)
  }","message":"${jsesc(f.message)}"}`;
}

export function renderJson(result: Result, kind: RenderKind): string {
  const file = jsesc(result.file);

  if (kind === "extension") {
    // Single-line form matching the sh extension short-circuit.
    const e = result.errors[0]!;
    return `{"file":"${file}","valid":false,"errors":[${
      entry(e)
    }],"warnings":[],"summary":{"requirements":0,"acceptanceCriteria":0}}\n`;
  }

  if (kind === "parse") {
    let out = `{"file":"${file}","valid":false,"errors":[`;
    result.errors.forEach((f, i) => {
      if (i > 0) out += ",";
      out += "\n  " + entry(f);
    });
    out += `\n],"warnings":[],"summary":{"requirements":0,"acceptanceCriteria":0}}\n`;
    return out;
  }

  // normal
  let out = `{"file":"${file}","valid":${result.valid ? "true" : "false"},"errors":[`;
  result.errors.forEach((f, i) => {
    if (i > 0) out += ",";
    out += "\n  " + entry(f);
  });
  out += `\n],"warnings":[`;
  result.warnings.forEach((f, i) => {
    if (i > 0) out += ",";
    out += "\n  " + entry(f);
  });
  out +=
    `\n],"summary":{"requirements":${result.summary.requirements},"acceptanceCriteria":${result.summary.acceptanceCriteria}}}\n`;
  return out;
}

/** Human-format lines. Returns { stderr, stdout } for the caller to route. */
export function renderHuman(result: Result, kind: RenderKind): { stderr: string; stdout: string } {
  let stderr = "";
  const findings = kind === "normal"
    ? [...result.errors, ...result.warnings].sort(compareFindings)
    : result.errors;

  if (kind === "extension") {
    const e = result.errors[0]!;
    stderr = `${e.rule} ${result.file}: ${e.message}\n`;
    return { stderr, stdout: "" };
  }

  if (kind === "parse") {
    for (const f of result.errors) {
      stderr += f.line > 0
        ? `${f.rule} LINE ${f.line}: ${f.message}\n`
        : `${f.rule}: ${f.message}\n`;
    }
    return { stderr, stdout: "" };
  }

  // normal — findings already sorted by the caller
  for (const f of findings) {
    stderr += f.line > 0
      ? `${f.rule} LINE ${f.line} ${f.path}: ${f.message}\n`
      : `${f.rule} ${f.path}: ${f.message}\n`;
  }
  let stdout = "";
  if (result.valid) {
    stdout =
      `OK: ${result.file} (${result.summary.requirements} requirements, ${result.summary.acceptanceCriteria} acceptance-criteria)\n`;
  }
  return { stderr, stdout };
}
