# yamlet for pi

The [yamlet](https://github.com/RicardoMonteiroSimoes/Yamlet) authoring flow ported to
the [pi coding agent](https://pi.dev). Same specs, same CLI, same EARS rules — a
different harness, with different things it can and cannot enforce.

The Claude Code build lives in [`plugins/yamlet-skills/`](../plugins/yamlet-skills).
This directory is the pi build. They are separate ports of one idea, not a shared
source: pi's skill model differs enough that a symlink would lie.

## Prerequisites

| | |
| --- | --- |
| **`yamlet` CLI** (required) | `brew tap RicardoMonteiroSimoes/yamlet && brew install yamlet` — every part of this shells out to it. |
| **`@tintinweb/pi-subagents`** (required for the challengers) | `pi install npm:@tintinweb/pi-subagents` — provides the `Agent` tool the two adversarial gates run in. Without it the author degrades loudly rather than skipping the gates. |

## Install

```sh
./install.sh              # global: ~/.pi/agent/{agents,skills}/
./install.sh --project    # project: ./.pi/{agents,skills}/
./install.sh --uninstall  # remove what it linked
```

It symlinks rather than copies, so `git pull` updates what pi loads.

The skills half is also a normal pi package (`pi install ./pi`), but **the agents
half is not installable that way** — `pi-subagents` discovers agents from exactly
three hardcoded directories (`.pi/agents/`, `.agents/agents/`,
`$PI_CODING_AGENT_DIR/agents/`) with no package discovery and no configurable path.
That is the whole reason `install.sh` exists.

> `pi install git:github.com/RicardoMonteiroSimoes/Yamlet` does **not** work today:
> pi reads the package manifest from the repository root, and this repo's root is a
> Deno project with no `package.json`. Adding one at the root (declaring
> `"pi": { "skills": ["./pi/skills"] }`) would make git installs work for the skills
> half — it is deliberately not done here, to avoid putting an npm manifest in the
> path of the Deno build. Clone-and-run `install.sh` is the supported route.

## What maps to what

The split is forced by one hard constraint: **pi's builtin toolset is exactly
`bash, edit, find, grep, ls, read, write` — there is no tool for asking the user a
question.** A pi subagent therefore runs headless and cannot interview anyone.

| Claude Code | pi | why |
| --- | --- | --- |
| `yamlet-author` skill | **skill** (`skills/yamlet-author/`) | It's an interview. It must stay in the main session where the human is. |
| `yamlet-contract-challenger` skill (`context: fork`) | **agent** (`agents/`) | Autonomous reviewer, takes a serialized proposal, returns a report. Exactly what a subagent is for. |
| `yamlet-criteria-challenger` skill (`context: fork`) | **agent** (`agents/`) | Same. |
| `yamlet-verifier` skill | **skill** | In Claude Code the `` !`cmd` `` body pre-executes `yamlet verify` and the output is already in the prompt. pi has no equivalent, so it becomes "run this, then interpret it." |
| `yamlet-tester` skill | **skill** | Same. |

Frontmatter for the two agents translates almost 1:1:

| Claude Code | pi-subagents |
| --- | --- |
| `context: fork` | `inherit_context` — set to `false` here (see below) |
| `model: opus` | `model: opus` |
| `effort: low` | `thinking: low` |
| `background: false` | `run_in_background: false` |
| `allowed-tools: Bash(yamlet systems:*), Read` | `tools: read, bash` + `isolated: true` (see below) |

**`inherit_context: false` is a deliberate change, not a shortfall.** Claude Code's
`context: fork` copies the parent conversation in. The challengers already receive
an explicit serialized proposal, so a fresh context makes them a *purer* adversary —
they cannot be anchored by the interview they are supposed to attack. Set
`inherit_context: true` if you want literal parity.

**`isolated: true` matters more than it looks.** Under pi-subagents, a `tools:` list
with no `ext:` entry restricts built-ins but still lets *every loaded extension's*
tools through. For a read-only adversary that is a hole — any write-capable
extension in the user's setup would land in the challenger's toolset. `isolated: true`
forces `extensions: false` + `skills: false`, so the challengers get `read` and
`bash` and nothing else.

## What is not enforced

`bash` is granular to the whole tool. pi has no `Bash(yamlet:*)` equivalent, and
`allowed-tools:` in a **skill** is documented but **not implemented** — pi parses
frontmatter into `{name, description, disable-model-invocation}` and drops the rest.
So the skills here carry no `allowed-tools` line: an inert field that looks like a
permission boundary is worse than no field.

Concretely, two gaps remain:

1. **The challengers can run any `bash` command.** They are told, firmly, that `bash`
   exists solely for `yamlet systems` / `yamlet verify --list-rules`. That is prose,
   not a gate.
2. **The author can write YAML by hand.** The one hard rule — *never write the file
   directly, always go through `yamlet`* — is what makes a spec correct by
   construction. In the main session `write` and `edit` are always present, and pi has
   no permission layer to remove them. The skill states this in the strongest terms it
   can, and nothing backs it up.

### Making the hard rule hard

Both gaps close the same way, and it is the natural next step for this port: a small
pi **extension** that

- registers one tool per `yamlet` subcommand (`yamlet_systems`, `yamlet_verify`,
  `yamlet_init`, `yamlet_add_requirement`, …), so the read/mutate split becomes
  structural instead of a regex over a command string; and
- installs a `tool_call` handler that blocks `write`/`edit` targeting `*.yamlet.yaml`
  — `pi.on("tool_call", …)` can return `{ block: true, reason }`, which is the only
  enforcement primitive pi ships.

With that in place the agents' `tools:` line becomes a one-line change and finally
expresses the original intent exactly:

```yaml
# agents/yamlet-contract-challenger.md
extensions: [yamlet]
tools: read, ext:yamlet/yamlet_systems     # was: isolated: true + tools: read, bash
```

```yaml
# agents/yamlet-criteria-challenger.md
extensions: [yamlet]
tools: read, ext:yamlet/yamlet_verify
```

The `tool_call` gate is the more important half: it holds in the **main** session,
which is where the author runs and where the subagent boundary cannot reach. It would
also make pi stricter than the Claude Code build, where `allowed-tools` constrains
only what happens inside a skill and the main agent can still hand-edit a spec.

## Layout

```
pi/
├── README.md
├── package.json                        # pi package manifest (skills only)
├── install.sh                          # links agents + skills into a pi-discoverable dir
├── agents/                             # requires @tintinweb/pi-subagents
│   ├── yamlet-contract-challenger.md
│   └── yamlet-criteria-challenger.md
└── skills/
    ├── yamlet-author/SKILL.md
    ├── yamlet-verifier/SKILL.md
    └── yamlet-tester/SKILL.md
```

The repo's own `.pi/agents/` and `.pi/skills/` entries symlink here, so a `pi`
session started in this repo picks all of it up with no install step — the same
convention as `.claude/skills/*` symlinking into `plugins/yamlet-skills/`.

> Why `.pi/` and not the cross-tool `.agents/` workspace: pi-subagents reads
> agents from `.agents/agents/`, but pi 0.84.2 does **not** read skills from
> `.agents/skills/` — `loadSkills` only looks at `<agentDir>/skills` and
> `<cwd>/.pi/skills`, whatever [the docs](https://pi.dev/docs/latest/skills) list.
> `.pi/` is the only directory where both halves are discovered.

## Usage

Start `pi` and ask for a spec, or invoke the author directly:

```
/skill:yamlet-author
```

The flow is unchanged from the Claude Code build: discover systems → agree the
contract → **contract challenge** → `init` → (composite: wire members) → per
requirement, draft then **criteria challenge** then commit → verify → regenerate the
Gherkin feature tree.
