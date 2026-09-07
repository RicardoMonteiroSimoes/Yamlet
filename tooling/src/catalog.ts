// Rule catalog — single source of truth, in the exact order the sh verifier
// lists them. The `description` here is the generic rule description shown by
// --list-rules; concrete finding messages are built at the point of detection.

import type { Severity } from "./types.ts";

export interface Rule {
  id: string;
  severity: Severity;
  description: string;
}

export const CATALOG: Rule[] = [
  {
    id: "E001",
    severity: "error",
    description:
      "file must use the .yamlet.yaml (spec), .techspec.yaml (tech spec) or .adr.yaml (decision record) extension",
  },
  { id: "E002", severity: "error", description: "tabs are not allowed; use spaces only" },
  { id: "E003", severity: "error", description: "indentation must be a multiple of 2 spaces" },
  {
    id: "E004",
    severity: "error",
    description: "flow collection not allowed as value; use block style or quote it",
  },
  {
    id: "E006",
    severity: "error",
    description: "YAML document markers (--- or ...) are not supported",
  },
  { id: "E008", severity: "error", description: "trailing whitespace on line" },
  { id: "E009", severity: "error", description: "duplicate mapping key within the same block" },
  { id: "E010", severity: "error", description: "empty sequence item (bare dash with no content)" },
  { id: "E101", severity: "error", description: "missing required top-level key" },
  { id: "E102", severity: "error", description: "unknown top-level key" },
  { id: "E103", severity: "error", description: "blast_radius must be one of: low medium high" },
  { id: "E104", severity: "error", description: "front must be one of: internal external" },
  {
    id: "E105",
    severity: "error",
    description: "system value must be a slug matching ^[a-z0-9]+(-[a-z0-9]+)*$",
  },
  { id: "E106", severity: "error", description: "requirements list is empty" },
  {
    id: "E107",
    severity: "error",
    description: "requirement or criterion missing a required field",
  },
  { id: "E108", severity: "error", description: "acceptance-criteria list is empty" },
  {
    id: "E109",
    severity: "error",
    description:
      "adrs entry is empty, duplicated in its block, not a .adr.yaml record, or does not resolve to a file",
  },
  { id: "E201", severity: "error", description: "requirement id must match ^RQ-[0-9]+$" },
  { id: "E202", severity: "error", description: "duplicate requirement id in file" },
  {
    id: "E203",
    severity: "error",
    description: "acceptance-criteria id must match ^AC-[0-9]+[a-z]?$",
  },
  { id: "E204", severity: "error", description: "duplicate acceptance-criteria id in file" },
  { id: "E301", severity: "error", description: "pattern requires a clause that is missing" },
  {
    id: "E302",
    severity: "error",
    description: "clause present that is not allowed for this pattern",
  },
  {
    id: "E303",
    severity: "error",
    description: "pattern=complex requires exactly one of when or if (not both, not neither)",
  },
  { id: "E304", severity: "error", description: "shall is missing or empty" },
  {
    id: "E401",
    severity: "error",
    description: "criterion has placeholders but no examples table",
  },
  { id: "E402", severity: "error", description: "example row missing a binding for a placeholder" },
  { id: "E403", severity: "error", description: "placeholder name must match ^[a-z][a-z0-9_]*$" },
  {
    id: "E501",
    severity: "error",
    description: "exposes.name is missing or not a slug matching ^[a-z0-9]+(-[a-z0-9]+)*$",
  },
  { id: "E502", severity: "error", description: "exposes.intent is missing or empty" },
  { id: "E503", severity: "error", description: "exposes input name must match ^[a-z][a-z0-9_]*$" },
  { id: "E504", severity: "error", description: "duplicate exposes input name" },
  {
    id: "E505",
    severity: "error",
    description: "input reference {input.NAME} does not resolve to a declared exposes input",
  },
  {
    id: "E506",
    severity: "error",
    description: "declared exposes input is never referenced as {input.NAME}",
  },
  {
    id: "E507",
    severity: "error",
    description: "unknown key under exposes (allowed: name, intent, inputs, outputs)",
  },
  {
    id: "E508",
    severity: "error",
    description: "exposes output name must match ^[a-z][a-z0-9_]*$",
  },
  { id: "E509", severity: "error", description: "duplicate exposes output name" },
  {
    id: "E510",
    severity: "error",
    description: "output reference {output.NAME} does not resolve to a declared exposes output",
  },
  {
    id: "E511",
    severity: "error",
    description: "declared exposes output is never referenced as {output.NAME}",
  },
  {
    id: "E601",
    severity: "error",
    description: "components list is empty or an entry is not a single alias: path mapping",
  },
  { id: "E602", severity: "error", description: "duplicate component alias" },
  {
    id: "E603",
    severity: "error",
    description: "component path does not resolve to an existing file",
  },
  {
    id: "E604",
    severity: "error",
    description:
      "member reference {alias.NAME} does not resolve to a declared input or output of the component",
  },
  {
    id: "E605",
    severity: "error",
    description: "connections requires a components list; a leaf cannot declare connections",
  },
  {
    id: "E606",
    severity: "error",
    description:
      "connection entry is malformed or its group is not a component alias or the reserved 'output'",
  },
  {
    id: "E607",
    severity: "error",
    description:
      "connection sink does not resolve to a declared input of the component (or composite output under 'output')",
  },
  {
    id: "E608",
    severity: "error",
    description: "connection source does not resolve to a composite input or a component output",
  },
  {
    id: "E609",
    severity: "error",
    description: "a declared component input is not bound by any connection",
  },
  {
    id: "E610",
    severity: "error",
    description: "a declared composite output is not fed by any connection",
  },
  // ── tech spec (.techspec.yaml): the gap analysis + task list projected from one spec ──
  {
    id: "E701",
    severity: "error",
    description: "tech spec is missing a required top-level key (spec, system, analysis)",
  },
  {
    id: "E702",
    severity: "error",
    description:
      "unknown top-level key in a tech spec (allowed: spec, system, analysis, requirements, tasks)",
  },
  {
    id: "E703",
    severity: "error",
    description: "tech spec's `spec` does not resolve to a parseable .yamlet.yaml next to it",
  },
  { id: "E704", severity: "error", description: "tech spec's system differs from its spec's" },
  {
    id: "E705",
    severity: "error",
    description:
      "analysis is malformed (commit must be 7–40 hex chars; deep/skimmed entries non-empty and disjoint; no other keys)",
  },
  {
    id: "E706",
    severity: "error",
    description: "a criterion of the spec has no verdict in the tech spec",
  },
  {
    id: "E707",
    severity: "error",
    description:
      "a recorded requirement or criterion is not in the spec, sits under the wrong requirement, or is recorded twice",
  },
  {
    id: "E708",
    severity: "error",
    description: "criterion verdict `met` is missing or not true|false",
  },
  { id: "E709", severity: "error", description: "a criterion marked met: true cites no evidence" },
  {
    id: "E710",
    severity: "error",
    description:
      "requirement or criterion entry is malformed (missing id, unknown key, empty evidence or note)",
  },
  {
    id: "E711",
    severity: "error",
    description:
      "task is malformed (id must match ^T-[0-9]+$ and be unique; title required; no other keys)",
  },
  {
    id: "E712",
    severity: "error",
    description:
      "task covers a criterion that is unknown, has no verdict, is already met, or is listed twice",
  },
  {
    id: "E713",
    severity: "error",
    description: "a task covering nothing needs `why`; a task covering criteria must not carry one",
  },
  {
    id: "E714",
    severity: "error",
    description: "depends_on names an unknown task, the task itself, a duplicate, or forms a cycle",
  },
  { id: "E715", severity: "error", description: "an unmet criterion is covered by no task" },
  {
    id: "E716",
    severity: "error",
    description:
      "an obligation (ADR-nnnn#R-n) of an accepted record linked from the spec is covered by no task",
  },
  // ── decision records (.adr.yaml, format adr/v1) ──
  {
    id: "E801",
    severity: "error",
    description:
      "ADR is missing a required top-level key (adr, title, status, date, kind, question, dimensions, options) or it is empty",
  },
  { id: "E802", severity: "error", description: "unknown top-level key in an ADR" },
  {
    id: "E803",
    severity: "error",
    description: "adr id must match ^ADR-[0-9]{4}$ and be unique within its directory",
  },
  {
    id: "E804",
    severity: "error",
    description:
      "status must be proposed|accepted|rejected|superseded; superseded_by present iff superseded, a later record that resolves",
  },
  { id: "E805", severity: "error", description: "date must be YYYY-MM-DD" },
  {
    id: "E806",
    severity: "error",
    description: "kind must be selection|mechanism|policy|boundary|sequencing",
  },
  {
    id: "E807",
    severity: "error",
    description:
      "origin: arises_from (<spec>.yamlet.yaml#RQ-n|AC-n, resolving) or assumes (a lower-numbered record; accepted only when accepted) must be non-empty",
  },
  {
    id: "E808",
    severity: "error",
    description:
      "forces entry is not a plain string, is empty, or cites an ADR-nnnn#R-n that does not resolve",
  },
  {
    id: "E809",
    severity: "error",
    description:
      "basis entry is malformed (id B-n unique, quantity with a numeral, source) or referenced by no dimension",
  },
  {
    id: "E810",
    severity: "error",
    description:
      "dimension is malformed (id D-n unique, matters; a unit needs a source and, when basis is declared, basis refs)",
  },
  {
    id: "E811",
    severity: "error",
    description:
      "options: fewer than two, or an option is malformed (id OPT-n unique, summary, reversibility; refs under selection; refs are locators)",
  },
  {
    id: "E812",
    severity: "error",
    description:
      "against must cover exactly the declared dimensions; n/a needs a reason, a cited excluding D-n must be substantive, a measured cell needs a numeral",
  },
  {
    id: "E813",
    severity: "error",
    description: "decision must be a declared option, and is required once accepted",
  },
  {
    id: "E814",
    severity: "error",
    description:
      "requires entry is malformed (id R-n unique, must), or an accepts entry is not a plain string",
  },
  {
    id: "E815",
    severity: "error",
    description: "revisit entry is not a plain string, or names a threshold without quantifying it",
  },
  {
    id: "W001",
    severity: "warning",
    description: "examples column has no matching placeholder (unused column)",
  },
  {
    id: "W002",
    severity: "warning",
    description: "examples present but no placeholders found in clauses",
  },
  {
    id: "W003",
    severity: "warning",
    description:
      "quantity word (exceeds, maximum, limit, at most, …) with no digit or {placeholder} binding it",
  },
  {
    id: "W004",
    severity: "warning",
    description: "an {output.NAME} whose value is described ('indicates …') rather than stated",
  },
  {
    id: "W005",
    severity: "warning",
    description: "open list ('such as', 'including', 'etc.') in a clause or shall",
  },
];

/** Severity lookup by rule id, mirroring the sh verifier's `catalog_sev`. */
export const CATALOG_SEV: Record<string, Severity> = Object.fromEntries(
  CATALOG.map((r) => [r.id, r.severity]),
);
