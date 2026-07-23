---
name: yamlet-verifier
description: Verifies a YAPL/EARS spec file (.yamlet.yaml) against the format rules and reports violations with stable rule IDs. REQUIRES one argument — the path to the .yamlet.yaml file to verify (e.g. `/yamlet-verifier specs/email.yamlet.yaml`). Use for agent self-verification of a spec before relying on it. If no file path is supplied it returns a usage error and does nothing.
allowed-tools: Bash(yamlet:*)
---

# Yamlet Verifier Skill

Verifies the `.yamlet.yaml` spec passed as the argument. This skill **only verifies** — it does not create, author, or fix specs.

## Result for `$ARGUMENTS`

!`yamlet verify "$ARGUMENTS" 2>&1`

Read the output above:

- `OK: …` — the spec is valid (exit 0).
- one or more `E###` lines — validation errors; the spec is invalid (exit 1).
- a `W###` line — non-fatal warning; does not affect validity.
- a usage error — no file path was supplied; re-invoke with the path to a `.yamlet.yaml` file (exit 2).

If there are any issues, you MUST consult with the user.

To resolve what a rule ID means, run `yamlet verify --list-rules`.

## Leaf vs composite: what "used" means (don't misread a passing spec)

A frequent false alarm: a **composite** spec whose declared inputs are not all referenced in its acceptance-criteria still verifies `OK`. That is correct, not a gap. "Used" is enforced differently per scope kind:

- **Leaf** — every declared input must be referenced as `{input.NAME}` (rule **E506**) and every output as `{output.NAME}` (**E511**) by some criterion.
- **Composite** — an input counts as used the moment it is a connection **source** (`input.X`); an output is satisfied by the `output`-group connection that feeds it. The enforced invariant is *wiring completeness*, not criterion references: **E609** (every component input is bound) and **E610** (every declared composite output is fed). A composite's criteria are optional, so a composite can pass with inputs that appear only in `connections:` and never in a `shall`.

So before flagging "an input isn't referenced in the criteria," check whether the file is a composite (has `components:`/`connections:`) — if so, look for the input as a connection source, not in a criterion.
