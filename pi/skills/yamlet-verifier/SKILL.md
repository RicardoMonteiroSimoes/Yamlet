---
name: yamlet-verifier
description: >-
  Verifies an EARS spec file (.yamlet.yaml) against the format rules and reports violations with
  stable rule IDs. REQUIRES the spec's path as its argument (e.g. `/skill:yamlet-verifier
  specs/email.yamlet.yaml`). Use to self-verify a spec before relying on it.
---

# Yamlet Verifier Skill

Verifies the `.yamlet.yaml` spec you were given a path to. This skill **only verifies** — it does not create, author, or fix specs.

## Run it

Take the spec path from the invocation; if none was supplied, ask the user for one and stop.

```
yamlet_verify({ file: "<path/to/spec.yamlet.yaml>" })
```

Unlike the Claude Code build, pi cannot pre-execute the check and hand you its output — you must actually call the tool before interpreting anything. **Never report a verification result you did not run.**

If `yamlet_verify` is not among your tools, the yamlet pi extension is not installed. Say so and stop; do not shell out to `yamlet` instead.

## Read the output

- `OK: …` — the spec is valid.
- one or more `E###` lines — validation errors; the spec is invalid.
- a `W###` line — non-fatal warning; does not affect validity, but raise it.
  `W008` (an `internal` spec no composite wires) is the one finding that depends on where verify runs: it scans the working directory for composites.

Finding errors is a **successful call reporting an invalid spec**, not a tool failure — read the findings and report them. If there are any issues, you MUST consult with the user.

To resolve what a rule ID means, call `yamlet_verify({ list_rules: true })`.

## Leaf vs composite: what "used" means (don't misread a passing spec)

A frequent false alarm: a **composite** spec whose declared inputs are not all referenced in its acceptance-criteria still verifies `OK`. That is correct, not a gap. "Used" is enforced differently per scope kind:

- **Leaf** — every declared input must be referenced as `{input.NAME}` (rule **E506**) and every output as `{output.NAME}` (**E511**) by some criterion.
- **Composite** — an input counts as used the moment it is a connection **source** (`input.X`); an output is satisfied by the `output`-group connection that feeds it. The enforced invariant is *wiring completeness*, not criterion references: **E609** (every component input is bound) and **E610** (every declared composite output is fed). A composite's criteria are optional, so a composite can pass with inputs that appear only in `connections:` and never in a `shall`.

So before flagging "an input isn't referenced in the criteria," check whether the file is a composite (has `components:`/`connections:`) — if so, look for the input as a connection source, not in a criterion.

## Do not fix by hand

If you are running inside the `yamlet-author` flow, the one hard rule still holds: an `E###` is corrected by working the change back through the `yamlet_*` author tools, never by editing the YAML. The extension's gate blocks `write`/`edit` on a `*.yamlet.yaml` anyway. Appending is always available; rewriting or removing committed text is not — if the fix needs that, say so plainly.
