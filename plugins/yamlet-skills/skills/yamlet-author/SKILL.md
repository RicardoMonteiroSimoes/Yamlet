---
name: yamlet-author
description: >-
  Creates and changes EARS spec files (.yamlet.yaml) by interviewing the user and driving the
  `yamlet` CLI — never by hand-writing YAML. Use when the user wants a new spec, a requirement or
  acceptance-criterion added to an existing one, an existing spec changed, or existing services
  wired together as a composite.
allowed-tools: Bash(yamlet:*), Read, Skill(yamlet-verifier *), Skill(yamlet-skills:yamlet-verifier *), Skill(yamlet-contract-challenger *), Skill(yamlet-skills:yamlet-contract-challenger *), Skill(yamlet-criteria-challenger *), Skill(yamlet-skills:yamlet-criteria-challenger *), Skill(yamlet-tester *), Skill(yamlet-skills:yamlet-tester *)
---

# Yamlet Author Skill

Turn a fuzzy idea into a **precise, testable, minimal** `.yamlet.yaml` spec, and keep it that way as it changes. You interrogate; you do not transcribe, and you do not decide. Never accept vagueness or an implicit definition.

## The one hard rule

**Never write or edit the YAML yourself** — no Write, no Edit, no shell redirection. Every change goes through `yamlet`, which owns serialization and mints every id. `Read` the file to show the user its state.

A `yamlet` refusal is an instruction, not a diagnostic: it names the file to fix, the command to run, or the ids that exist. Do what it says. Never work around it by hand.

## Route first

Ask **one** question before anything else:

> Are we writing a **new** spec, or **changing** one that already exists?

| Answer | Read |
|---|---|
| New spec | `references/creating.md` |
| …and it wires existing services together | `references/creating.md`, then `references/composites.md` |
| Changing an existing spec | `references/editing.md` |

Read `references/patterns.md` when you reach acceptance-criteria — the EARS table and the three kinds of `{token}`.

Load only the one in play, never all of them. Each covers its own setup and returns you here; everything after setup is shared.

## The interview

Top-down, plain prose, one thing at a time: ask, listen, drill, confirm, commit — then move on. Never dump a form on the user. Ask in simple terms, in wordings that cannot be misread.

Push back on vagueness. "Handles errors" → *which* errors, and *what* behaviour? One capability per requirement.

## Reading the tool's response

- **exit 0** — `add-*` prints the assigned id (`RQ-1`, `AC-3`).
- **exit 2** — `error:`, and nothing was written. Fix the input and retry.
- **exit 3** — the change tripped a validation finding and the file was rolled back. Tell the user: the change is not expressible as asked.

**Never invent an id** — use the one the tool printed. Ids are permanent, never reused and never renumbered; a deleted criterion leaves a gap, and the gap is correct.

## Working rhythm

1. Route, and follow that procedure's setup.
2. Per requirement: draft its description and criteria with the user, **challenge them** (below), settle the objections, then commit — `add-requirement`, then `add-criterion` per criterion.
3. A requirement with no criteria is incomplete. Give it at least one.
4. Read the file back and confirm it captures the source of truth.
5. **Verify** (below).
6. **Project the tests** (below).

### Challenge before you commit

Draft the requirement's description **and** its full set of criteria in conversation first. Then invoke **`yamlet-criteria-challenger`** (`/yamlet-criteria-challenger <proposal>`) with: the description; every intended criterion (pattern, clauses, `shall` items, placeholders/examples); and the scope's front and contract.

Relay its findings in prose — you do not obey it blindly. Resolve every **BLOCKER** before committing, put its **QUESTIONS** to the user, and surface its **SUGGESTIONS** for a decision.

Once per requirement, before its commit. Never batch them to the end.

## Verify

As the closing gate, invoke **`yamlet-verifier`** with the spec's path (`/yamlet-verifier <path>`). Not done until it reports no errors; raise any warning with the user.

Verify at the **end**, not after `init` — a declared-but-unreferenced contract input is an error until the criteria or connections that use it exist.

On an `E###`, work the correction back through the `yamlet` commands. `yamlet verify --list-rules` explains an id.

## Project the tests

Once verification passes, invoke **`yamlet-tester`** with the specs **directory** (`/yamlet-tester <specs-dir>`) — never a single file; the projection is whole-tree. Once, at the end, not per requirement. The work is not complete until it has run.

Carry its report back to the user: new or changed scenarios need step definitions, and those live in the consumer's own directory, never in the generated tree.

## If you're asked for a graph

Hand the user the path `yamlet graph --out=FILE` reports. **Never `Read` the file back.**
