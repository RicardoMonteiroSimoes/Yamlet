# yamlet-skills

Claude Code skills for authoring, verifying and planning against [yamlet](https://github.com/RicardoMonteiroSimoes/Yamlet)
minimal, testable `.yamlet.yaml` specs with EARS acceptance criteria.

| Skill | What it does |
| --- | --- |
| `yamlet-author` | Interviews you to build **or change** a spec, driving the `yamlet` CLI (never writing YAML directly). Routes on "new spec, or changing an existing one?" and loads the matching procedure from its `references/` directory. Orchestrates the challengers, verifier and tester below. |
| `yamlet-contract-challenger` | Adversarial gate before `yamlet init` freezes a scope's contract. |
| `yamlet-criteria-challenger` | Adversarial gate before each requirement + acceptance-criteria is committed. |
| `yamlet-verifier` | Verifies a `.yamlet.yaml` against the format rules and reports violations. |
| `yamlet-tester` | Projects a specs directory into a Gherkin `.feature` tree, wiping and rebuilding the target every run so the tests never drift. Disconnected: it writes features only, never step definitions. |
| `yamlet-techspec` | Plans the work for a **finished** spec: reads the code it should implement, records a verdict per criterion with `file:line` evidence, then a task list covering every unmet one — all through `yamlet techspec` into a disposable `.techspec.yaml`. Where a task needs a decision, it writes the ADR and links it into the spec with `yamlet add-adr`. Orchestrates the two below. |
| `yamlet-code-research` | Read-only research inside the tech spec flow: per requirement, where each criterion's behaviour lives, what the code does there, deviations from each `shall`, related tests. Documents, never judges. |
| `yamlet-evidence-challenger` | Adversarial gate before a criterion is recorded as met: opens exactly the offered `file:line` references and says, per `shall`, whether it is really satisfied there. Nothing else. |

## Prerequisite: the `yamlet` CLI

**These skills are inert without the `yamlet` binary on your `PATH`** — every one of them
shells out to `yamlet`. Install it first:

```sh
brew tap RicardoMonteiroSimoes/yamlet
brew install yamlet
```

Verify with `yamlet --version`.

## Install

```
/plugin marketplace add RicardoMonteiroSimoes/Yamlet
/plugin install yamlet-skills@yamlet
```

Then start with `/yamlet-author` (or let Claude invoke it when you ask to write a spec). Once a
spec is finished, `/yamlet-techspec specs/<scope>.yamlet.yaml` plans the work against your code.

## Using pi instead?

The same flow is ported to the [pi coding agent](https://pi.dev) under
[`pi/`](../../pi) in this repo — `pi install git:github.com/RicardoMonteiroSimoes/Yamlet`.
There the CLI is registered as native pi tools and hand-editing a `.yamlet.yaml`
is blocked outright, because pi has no permission layer to express that with.
The tech spec flow (`yamlet-techspec` and its two helpers) is not ported yet.

## Source

These skills live at [`plugins/yamlet-skills/skills/`](./skills) in the
[yamlet repo](https://github.com/RicardoMonteiroSimoes/Yamlet). The repo's own
`.claude/skills/` entries are symlinks into this directory, so there is a single
source of truth — edit the files here.
