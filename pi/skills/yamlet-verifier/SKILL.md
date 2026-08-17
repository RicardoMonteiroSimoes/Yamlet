---
name: yamlet-verifier
description: >-
  Verifies an EARS spec file (.yamlet.yaml) against the format rules and reports violations with stable rule IDs. Needs one argument — the path to the .yamlet.yaml file to verify (e.g. `/skill:yamlet-verifier specs/email.yamlet.yaml`). Use for agent self-verification of a spec before relying on it, and as the closing gate of the yamlet-author flow. It only verifies — it never creates, authors, or fixes specs. If no file path was supplied, ask for one and do nothing else.
---

# Yamlet Verifier Skill

Verifies the `.yamlet.yaml` spec you were given a path to. This skill **only verifies** — it does not create, author, or fix specs.

## Run it

Take the spec path from the invocation (if none was supplied, ask the user for one and stop):

```
yamlet verify "<path/to/spec.yamlet.yaml>"
```

> Unlike the Claude Code build of this skill, pi has no way to pre-execute the command and hand you its output — you must actually run it with `bash` before interpreting anything. **Never report a verification result you did not run.**

## Read the output

- `OK: …` — the spec is valid (exit 0).
- one or more `E###` lines — validation errors; the spec is invalid (exit 1).
- a `W###` line — non-fatal warning; does not affect validity.
- a usage error — no file path was supplied; re-invoke with the path to a `.yamlet.yaml` file (exit 2).

If there are any issues, you MUST consult with the user.

To resolve what a rule ID means, run `yamlet verify --list-rules`.

## Do not fix by hand

If you are running inside the `yamlet-author` flow, the one hard rule still holds: an `E###` is corrected by working the change back through the `yamlet` author commands, never by editing the YAML. If the correction needs a block that is already committed, say so plainly — this version cannot edit committed content.
