# yamlet-skills

Claude Code skills for authoring and verifying [yamlet](https://github.com/RicardoMonteiroSimoes/Yamlet)
minimal, testable `.yamlet.yaml` specs with EARS acceptance criteria.

| Skill | What it does |
| --- | --- |
| `yamlet-author` | Interviews you to build a spec, appending through the `yamlet` CLI (never writing YAML directly). Orchestrates the challengers, verifier and tester below. |
| `yamlet-contract-challenger` | Adversarial gate before `yamlet init` freezes a scope's contract. |
| `yamlet-criteria-challenger` | Adversarial gate before each requirement + acceptance-criteria is committed. |
| `yamlet-verifier` | Verifies a `.yamlet.yaml` against the format rules and reports violations. |
| `yamlet-tester` | Projects a specs directory into a Gherkin `.feature` tree, wiping and rebuilding the target every run so the tests never drift. Disconnected: it writes features only, never step definitions. |

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

Then start with `/yamlet-author` (or let Claude invoke it when you ask to write a spec).

## Source

These skills live at [`plugins/yamlet-skills/skills/`](./skills) in the
[yamlet repo](https://github.com/RicardoMonteiroSimoes/Yamlet). The repo's own
`.claude/skills/` entries are symlinks into this directory, so there is a single
source of truth — edit the files here.
