---
name: yamlet-verifier
description: >-
  Verifies an EARS spec file (.yamlet.yaml) against the format rules and reports violations with
  stable rule IDs. REQUIRES one argument — the path to the .yamlet.yaml file to verify (e.g.
  `/yamlet-verifier specs/email.yamlet.yaml`). Use for agent self-verification of a spec before
  relying on it. If no file path is supplied it returns a usage error and does nothing.
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

If you are running inside the `yamlet-author` flow, the one hard rule still holds: an `E###` is corrected by working the change back through the `yamlet_*` author tools, never by editing the YAML. The extension's gate blocks `write`/`edit` on a `*.yamlet.yaml` anyway. Appending — a requirement, or a criterion under any requirement — is always available. If the correction instead needs already-committed text rewritten or removed, say so plainly: this version cannot do that yet.
