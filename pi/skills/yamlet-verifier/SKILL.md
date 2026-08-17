---
name: yamlet-verifier
description: >-
  Verifies an EARS spec file (.yamlet.yaml) against the format rules with the yamlet_verify tool and reports violations with stable rule IDs. Needs one argument — the path to the .yamlet.yaml to verify (e.g. `/skill:yamlet-verifier specs/email.yamlet.yaml`). Use for agent self-verification of a spec before relying on it, and as the closing gate of the yamlet-author flow. It only verifies — it never creates, authors, or fixes specs. If no file path was supplied, ask for one and do nothing else.
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

Finding errors is a **successful call reporting an invalid spec**, not a tool failure — read the findings and report them. If there are any issues, you MUST consult with the user.

To resolve what a rule ID means, call `yamlet_verify({ list_rules: true })`.

## Do not fix by hand

If you are running inside the `yamlet-author` flow, the one hard rule still holds: an `E###` is corrected by working the change back through the `yamlet_*` author tools, never by editing the YAML. The extension's gate blocks `write`/`edit` on a `*.yamlet.yaml` anyway. If the correction needs a block that is already committed, say so plainly — this version cannot edit committed content.
