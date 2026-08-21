---
name: yamlet-author
description: >-
  Creates and changes EARS spec files (.yamlet.yaml) by interviewing the user and driving the
  `yamlet_*` tools — never by hand-writing YAML. Use when the user wants a new spec, a requirement
  or acceptance-criterion added to an existing one, an existing spec changed, or existing services
  wired together as a composite.
---

# Yamlet Author Skill

Turn a fuzzy idea into a **precise, testable, minimal** `.yamlet.yaml` spec, and keep it that way as it changes. You interrogate; you do not transcribe, and you do not decide. Never accept vagueness or an implicit definition.

## Prerequisite

This skill drives the `yamlet_*` tools from the yamlet pi extension. Without `yamlet_systems`, `yamlet_guide`, `yamlet_init` and friends, **stop and tell the user** to install it:

```sh
pi install git:github.com/RicardoMonteiroSimoes/Yamlet   # the extension and skills
brew install yamlet                                      # the CLI they shell out to
```

Never fall back to `yamlet` through `bash`.

## The one hard rule

**Never write or edit the YAML yourself.** Every change goes through the `yamlet_*` tools, which own serialization and mint every id. `read` the file to show the user its state.

Here this is enforced, not requested: the extension blocks `write` and `edit` on any `*.yamlet.yaml`, and blocks shell redirects, `tee` and `sed -i` aimed at one. Being blocked is the rule working — do not look for a way around it.

A tool refusal is an instruction, not a diagnostic: it names the file to fix, the parameter to change, or the ids that exist. Do what it says.

## Route first

Ask **one** question before anything else:

> Are we writing a **new** spec, or **changing** one that already exists?

| Answer | Call |
|---|---|
| New spec | `yamlet_guide({ topic: "creating" })` |
| …and it wires existing services together | `creating`, then `yamlet_guide({ topic: "composites" })` |
| Changing an existing spec | `yamlet_guide({ topic: "editing" })` |

Load `yamlet_guide({ topic: "patterns" })` when you reach acceptance-criteria — the EARS table and the three kinds of `{token}`.

Load only the one in play, never all of them. Each covers its own setup and returns you here; everything after setup is shared.

## The interview

Top-down, plain prose, one thing at a time: ask, listen, drill, confirm, commit — then move on. Never dump a form on the user. Ask in simple terms, in wordings that cannot be misread.

Push back on vagueness. "Handles errors" → *which* errors, and *what* behaviour? One capability per requirement.

## Reading a tool's response

The `add_*` tools return the assigned id (`RQ-1`, `AC-3`). A failure returns `error:` and wrote nothing — fix the input and retry. `yamlet_verify` is the exception: `E###` findings are a successful call reporting an invalid spec, not a tool failure.

**Never invent an id** — use the one the tool returned. Ids are permanent, never reused and never renumbered; a deleted criterion leaves a gap, and the gap is correct.

## Working rhythm

1. Route, and follow that procedure's setup.
2. Per requirement: draft its description and criteria with the user, **challenge them** (below), settle the objections, then commit — `yamlet_add_requirement`, then `yamlet_add_criterion` per criterion.
3. A requirement with no criteria is incomplete. Give it at least one.
4. Read the file back and confirm it captures the source of truth.
5. **Verify** (below).
6. **Project the tests** (below).

### Challenge before you commit

Draft the requirement's description **and** its full set of criteria in conversation first. Then spawn the **`yamlet-criteria-challenger`** agent with: the description; every intended criterion (pattern, clauses, `shall` items, placeholders/examples); and the scope's front and contract.

```
Agent({
  subagent_type: "yamlet-criteria-challenger",
  description: "Challenge RQ before commit",
  prompt: "<requirement + its intended criteria + contract context>"
})
```

It is headless and cannot ask the user anything, so relay its findings in prose — you do not obey it blindly. Resolve every **BLOCKER** before committing, put its **QUESTIONS** to the user, and surface its **SUGGESTIONS** for a decision.

Once per requirement, before its commit. Never batch them to the end.

### If there is no `Agent` tool

The gates need [`@tintinweb/pi-subagents`](https://pi.dev/packages/@tintinweb/pi-subagents). Without it, do not skip them. Tell the user once that you are running the challenge inline, in your own context, and that it is a weaker check. Then work the real checklist — `yamlet_guide({ topic: "contract-challenge" })` or `{ topic: "criteria-challenge" })` — never your memory of it, and report in the same shape. Be harder on yourself to compensate.

## Verify

As the closing gate, load the **`yamlet-verifier`** skill and follow it against the spec's path. Not done until it reports no errors; raise any warning with the user.

Verify at the **end**, not after init — a declared-but-unreferenced contract input is an error until the criteria or connections that use it exist.

On an `E###`, work the correction back through the author tools. `yamlet_verify({ list_rules: true })` explains an id.

## Project the tests

Once verification passes, load the **`yamlet-tester`** skill and follow it against the specs **directory** — never a single file; the projection is whole-tree. Once, at the end, not per requirement. The work is not complete until it has run.

Carry its report back to the user: new or changed scenarios need step definitions, and those live in the consumer's own directory, never in the generated tree.

## If you're asked for a graph

Hand the user the path `yamlet_graph` reports. **Never read the file back.**
