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
  { id: "E001", severity: "error", description: "file must use the .yamlet.yaml extension" },
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
];

/** Severity lookup by rule id, mirroring the sh verifier's `catalog_sev`. */
export const CATALOG_SEV: Record<string, Severity> = Object.fromEntries(
  CATALOG.map((r) => [r.id, r.severity]),
);
