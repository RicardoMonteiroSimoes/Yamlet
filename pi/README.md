# yamlet for pi

The [yamlet](https://github.com/RicardoMonteiroSimoes/Yamlet) authoring flow ported to
the [pi coding agent](https://pi.dev). Same specs, same CLI, same EARS rules — a
different harness, with different things it can and cannot enforce.

The Claude Code build lives in [`plugins/yamlet-skills/`](../plugins/yamlet-skills).
This directory is the pi build. They are separate ports of one idea, not a shared
source: pi's model differs enough that a symlink would lie.

## Prerequisites

| | |
| --- | --- |
| **`yamlet` CLI** (required) | `brew tap RicardoMonteiroSimoes/yamlet && brew trust --tap RicardoMonteiroSimoes/yamlet && brew install yamlet` (Homebrew 6+ gates non-official taps behind the trust step) — the extension shells out to it and is inert without it. It is checked at session start, and again on every tool call, with an actionable message either way. A CLI from before tech specs and decision records (0.2.3) still loads: the authoring tools work, the planning tools fail with an upgrade hint, and the session says so once at startup. |
| **`@tintinweb/pi-subagents`** (required for the agents) | `pi install npm:@tintinweb/pi-subagents` — provides the `Agent` tool the four adversarial gates and the code researcher run in. Without it the skills degrade loudly rather than skipping those steps. |

The binary is **not** bundled. Keeping it out preserves the rule the Claude Code
plugin follows — ship no binary, call bare `yamlet` on PATH — and keeps yamlet's
release flow (GitHub Releases + the Homebrew tap) the single distribution channel.

## Install

The port and the CLI share one version number, so pin the port to the release
whose CLI you run:

```sh
pi install npm:yamlet-pi@0.3.0
# or straight from the repo, at the same tag
pi install git:github.com/RicardoMonteiroSimoes/Yamlet@v0.3.0
```

Unpinned — `pi install git:github.com/RicardoMonteiroSimoes/Yamlet` — tracks
`main`, so every merge reaches you on the next `pi update`. Either way there is no
clone to manage and no build step: pi loads the extension's TypeScript through
`jiti` at runtime and aliases its `@earendil-works/*` and `typebox` imports to its
own bundled copies, so the package pulls no dependencies.

The git source works because of the small **private** `package.json` at the repo
root, whose only job is to point pi at `pi/extensions` and `pi/skills`. It declares
no dependencies and no scripts, and `tooling/` imports nothing bare, so it does not
participate in the Deno build. It is `"private": true`, so it can never be
published by accident — the publishable manifest is `pi/package.json`, and the
release workflow publishes it.

Working on the port itself, or want it to track a clone? Use the script instead —
it symlinks rather than copies, so `git pull` updates what pi loads:

```sh
./install.sh              # global: ~/.pi/agent/{extensions,agents,skills}/
./install.sh --project    # project: ./.pi/{extensions,agents,skills}/
./install.sh --uninstall  # remove what it linked
```

`pi install ./pi` works too, for a local path without symlinks.

### The agents are the exception

`pi-subagents` discovers agents from exactly three hardcoded directories
(`.pi/agents/`, `.agents/agents/`, `$PI_CODING_AGENT_DIR/agents/`) — no package
discovery, no configurable path, and its cross-extension RPC exposes only
ping/spawn/stop, so there is no registration hook either. **A package physically
cannot ship them.**

Rather than half-install, the extension offers to place them itself: on the first
session where pi-subagents is present and any of the five agents is absent, it
asks, and on yes copies the missing ones into `$PI_CODING_AGENT_DIR/agents/`. It
stays silent when pi-subagents is not installed (nothing would use them), never
writes without a UI to ask through, and never overwrites a file whose contents
differ from what the package ships — it reports the difference instead, so a local
edit survives (an upgrade that adds agents installs the new ones and names the
edited old ones it left alone). pi-subagents reads agents at startup, so the new
ones need a restart or `/reload`.

`install.sh` places them directly, without the prompt.

## The yamlet tools

`extensions/yamlet/` registers **one tool per `yamlet` subcommand** (and per
`techspec`/`adr` sub-subcommand), so the read/mutate split is expressible in a
`tools:` line instead of hoped for in prose:

| read | mutate a spec | project | tech spec | decision record |
| --- | --- | --- | --- | --- |
| `yamlet_systems` | `yamlet_init` | `yamlet_tests` | `yamlet_techspec_init` | `yamlet_adr_init` |
| `yamlet_verify` | `yamlet_add_component` | `yamlet_graph` | `yamlet_techspec_analysis` | `yamlet_adr_add_force` |
| `yamlet_impact` | `yamlet_add_connection` | | `yamlet_techspec_criterion` | `yamlet_adr_add_basis` |
| `yamlet_guide` | `yamlet_add_requirement` | | `yamlet_techspec_task` | `yamlet_adr_add_dimension` |
| | `yamlet_add_criterion` | | | `yamlet_adr_add_option` |
| | `yamlet_add_adr` | | | `yamlet_adr_decide` |
| | | | | `yamlet_adr_add_obligation` |
| | | | | `yamlet_adr_add_accept` |
| | | | | `yamlet_adr_add_revisit` |
| | | | | `yamlet_adr_accept` · `_reject` |
| | | | | `yamlet_adr_supersede` |

The **tech spec** and **decision record** columns are the planning flow: every one
of them is a mutation of a file the CLI owns whole. Each tool's schema is the CLI's
phase order made visible — `yamlet_adr_add_option` takes every dimension's cell in
one call because the CLI does, and `yamlet_add_adr` refuses anything but exactly
one of `rq`/`ac` before running. One tool reads outside the CLI:
`yamlet_techspec_analysis` resolves the commit it pins from `git rev-parse` in the
code root, so the SHA is what git says and never a remembered string; pass
`commit` only to pin a different one.

The **project** column writes yamlet-owned artifacts — a Gherkin tree, a graph —
and never a spec. Both take their destination as a required argument and return
only a summary of what they wrote. For `yamlet_graph` that is the whole point:
`--format=html` is a whole viewer before the first spec (tens of KB, ~1.6 MB
with `--libs=embed`), so returning the payload as a tool result would burn the
session's context for nothing. Hand the user the path; never read the file back.

Arguments go across as an argv array, never a shell string, so there is no quoting
or injection surface. Exit codes keep yamlet's own meaning: `verify` exiting 1 is a
*result* (the findings come back for the model to read), while 2 (usage) and 3
(rolled-back mutation) are thrown so pi flags the call as failed.

**This is the whole reason the port needs executable code**, and why the skills
require it rather than falling back to `bash`. A fallback would mean two code paths
where only one is enforceable, and the unenforceable one would silently become the
normal one.

### `yamlet_guide` — why a tool serves the author's own documentation

`yamlet_guide` is the odd one out: it shells out to nothing and reads a bundled
markdown file. It exists because of a difference between the two harnesses.

The author skill is a **router** — it asks whether this is a new spec or a change to
an existing one, then reads only the procedure that applies, which keeps the
always-loaded body small. On Claude Code that is a plain relative read: the
`.claude/skills/*` symlinks point at skill *directories*, so a `references/` folder
travels with the skill and the harness tells the skill where it lives.

pi gives no such guarantee. A skill installed into `~/.pi/agent/skills/` cannot know
its own absolute path, so "read the file next to me" is not expressible. The
**extension** can — it already resolves `../../agents` from `import.meta.url` to offer
the challengers — so it resolves `../../skills/yamlet-author/references` the same way
and hands the text back as a tool result. Guessing a path becomes a tool call.

The procedures live in `skills/yamlet-author/references/` (mirroring the Claude Code
layout, so the two ports stay legible side by side) and the smoke test asserts the
tool returns those exact files, not a stub — if they move, it fails.

The tech spec skill's own reference (`decisions` — the gate it runs when a task
needs a choice the user owns) is served the same way, from
`skills/yamlet-techspec/references/`.

It also serves the agents' **procedures** (`contract-challenge`,
`criteria-challenge`, `code-research`, `evidence-challenge`, `adr-challenge`)
straight out of `agents/`. Those are for the degraded path only: with
`@tintinweb/pi-subagents` absent there is no `Agent` tool, so the skill must run
the gate — or the code research — inline, and "go find the agent file yourself" is
the instruction that quietly becomes "skip the gate". Serving the real checklist
keeps the weaker path honest instead of leaving it to the model's memory of it.

## What is enforced

**The one hard rule — never hand-write a file yamlet owns — is a gate, not a
request.** A `tool_call` handler blocks `write` and `edit` on any `*.yamlet.yaml`,
`*.techspec.yaml` or `*.adr.yaml`, and blocks the obvious shell equivalents (a
redirect, `tee`, or `sed -i` aimed at one; a plain `yamlet …` invocation still
passes). Each refusal names the tools to use instead. This holds in the **main
session**, which is where the interviewing skills run and where no subagent
tool-scoping can reach — it makes pi stricter than the Claude Code build, where
`allowed-tools` constrains only what happens inside a skill and the main agent can
still hand-edit a spec.

**The agents are read-only structurally.** A challenger that needs the CLI gets
`read` plus exactly one yamlet tool; the three that do not get no extension at all:

```yaml
# agents/yamlet-contract-challenger.md
extensions: [yamlet]
skills: false
tools: read, ext:yamlet/yamlet_systems

# agents/yamlet-code-research.md — the only one that may search
extensions: false
skills: false
tools: read, grep, find, ls

# agents/yamlet-evidence-challenger.md, yamlet-adr-challenger.md
extensions: false
skills: false
tools: read
```

No `bash`, no `write`, no `edit`, no mutating `yamlet_*`. `extensions: [yamlet]`
matters as much as the selector: without it, every *other* loaded extension's tools
would surface in a supposedly read-only adversary, because a `tools:` list only
constrains built-ins until an `ext:` entry flips extension tools to an allowlist.
`extensions: false` is the same guarantee for an agent that needs no extension
tool at all. The evidence challenger deliberately has no `grep`: it checks the
references it was handed and nothing else, and a search tool would let it go
looking for better evidence than the tech spec offered.

## What is still not enforced

Honest residue, in descending order of how much it should bother you:

1. **`bash` in the main session is unbounded.** The shell check is a high-precision
   filter for the accidental hand-write, not a boundary — anyone determined can
   evade it (`python -c`, a heredoc through an interpreter, an unusual tool). The
   `write`/`edit` gate is the real guarantee; the shell check only catches the slip.
2. **A skill's `allowed-tools` frontmatter still does nothing.** pi documents the
   field but parses frontmatter into `{name, description, disable-model-invocation}`
   and drops the rest, so the skills here carry no `allowed-tools` line — an inert
   field that looks like a permission boundary is worse than no field. Tool scoping
   exists only at the subagent boundary and in the extension's gate.
3. **`yamlet_tests` wipes its target directory.** That is the design (the projection
   can never drift), but it is a destructive call reachable by a tool, so the tool
   carries a `promptGuidelines` warning and the skill refuses to guess a directory.

## Layout

```
pi/
├── README.md
├── LICENSE                             # MIT, so the published tarball carries it
├── package.json                        # pi package manifest (extension + skills)
├── install.sh                          # links all three into a pi-discoverable dir
├── scripts/check-install.mjs           # CI: the manifests resolve through pi's loader
├── extensions/yamlet/
│   ├── index.ts                        # the yamlet_* tools + the write/edit gate
│   └── smoke.test.mjs                  # mock-pi harness: argv construction + gate
├── agents/                             # requires @tintinweb/pi-subagents
│   ├── yamlet-contract-challenger.md   # author: before init freezes the contract
│   ├── yamlet-criteria-challenger.md   # author: before a requirement is committed
│   ├── yamlet-code-research.md         # tech spec: where each criterion lives (read/grep/find/ls)
│   ├── yamlet-evidence-challenger.md   # tech spec: before a criterion is recorded as met
│   └── yamlet-adr-challenger.md        # adr: after the dimensions, before any option
└── skills/
    ├── yamlet-author/
    │   ├── SKILL.md                    # the router: route, gates, closing steps
    │   └── references/                 # served by `yamlet_guide`, not read directly
    │       ├── creating.md             #   new spec: discovery -> contract -> init
    │       ├── editing.md              #   existing spec: locate -> impact -> change
    │       ├── composites.md           #   members and wiring
    │       └── patterns.md             #   EARS patterns and {token} kinds
    ├── yamlet-verifier/SKILL.md
    ├── yamlet-tester/SKILL.md
    ├── yamlet-techspec/
    │   ├── SKILL.md                    # verdicts per criterion, then tasks, through yamlet_techspec_*
    │   └── references/decisions.md     # the decision gate (served as `decisions`)
    └── yamlet-adr/SKILL.md             # the decision record interview, through yamlet_adr_*
```

To dogfood the port from this repo, run `./pi/install.sh --project` once — it
links all three into `.pi/`, which pi discovers from the working directory. `.pi/`
is **gitignored**, not tracked: pi writes its own machine-local state there
(`pi install -l` packages, settings), so it is only ever a generated view of `pi/`,
which is the source of truth. This is the one place the pi port deliberately
differs from `.claude/skills/*`, which *is* tracked as symlinks into the plugin.

> Why `.pi/` and not the cross-tool `.agents/` workspace: pi 0.84.4 reads skills
> from `.agents/skills/` and pi-subagents reads agents from `.agents/agents/`, but
> extensions load only from `.pi/extensions/`. `.pi/` is the only directory where
> all three are discovered.

## What maps to what

The split is forced by one hard constraint: **pi's builtin toolset is exactly
`bash, edit, find, grep, ls, read, write` — there is no tool for asking the user a
question.** A pi subagent therefore runs headless and cannot interview anyone.

| Claude Code | pi | why |
| --- | --- | --- |
| `yamlet-author` skill | **skill** | It's an interview. It must stay in the main session where the human is. |
| `yamlet-contract-challenger` (`context: fork`) | **agent** | Autonomous reviewer, takes a serialized proposal, returns a report. Exactly what a subagent is for. |
| `yamlet-criteria-challenger` (`context: fork`) | **agent** | Same. |
| `yamlet-verifier` skill | **skill** | In Claude Code the `` !`cmd` `` body pre-executes and the output is already in the prompt. pi has no equivalent, so it becomes "call the tool, then interpret." |
| `yamlet-tester` skill | **skill** | Same. |
| `yamlet-techspec` skill | **skill** | It puts the decision gate to the user and relays every `DECIDED` notice. Stays where the human is. |
| `yamlet-code-research` (`context: fork`) | **agent** | Autonomous: a code root and one requirement in, `file:line` facts out. `tools: read, grep, find, ls`, `extensions: false`. |
| `yamlet-evidence-challenger` (`context: fork`) | **agent** | Autonomous, and narrower still: `tools: read` only, so it can check the offered references and cannot go looking for others. |
| `yamlet-adr` skill | **skill** | An interview: the user decides. `yamlet-techspec`'s decision gate loads it in the same session rather than spawning it, because a subagent could not ask. |
| `yamlet-adr-challenger` (`context: fork`) | **agent** | Autonomous reviewer of a record's judgement, `tools: read`. |

Agent frontmatter translates almost 1:1:

| Claude Code | pi-subagents |
| --- | --- |
| `context: fork` | `inherit_context` — set to `false` here (see below) |
| `model: opus` | *(not set)* — the agent inherits the session's model; a pin would tie the port to one provider |
| `effort: low` | `thinking: low` — pi clamps a level the model lacks, so this stays provider-agnostic |
| `allowed-tools: Bash(yamlet systems:*), Read` | `tools: read, ext:yamlet/yamlet_systems` |

**`inherit_context: false` is a deliberate change, not a shortfall.** Claude Code's
`context: fork` copies the parent conversation in. The challengers already receive
an explicit serialized proposal, so a fresh context makes them a *purer* adversary —
they cannot be anchored by the interview they are supposed to attack. Set
`inherit_context: true` if you want literal parity.

## Testing the extension

```sh
npx tsx pi/extensions/yamlet/smoke.test.mjs
```

Run it from somewhere the pi peer deps resolve (`@earendil-works/pi-coding-agent`,
`@earendil-works/pi-ai`, `typebox`). It drives the extension with a mock `pi`
handle and asserts the two places a silent bug would live: the argv each tool
builds, and the gate's block/allow decisions.

[`.github/workflows/pi-port.yml`](../.github/workflows/pi-port.yml) runs it on
every PR against the latest published pi, then installs the package both ways a
user can — `pi install ./pi` and the repo root, which is what `git:` clones — and
asks pi's own resource loader whether the extension and all five skills resolved
([`scripts/check-install.mjs`](scripts/check-install.mjs)). A manifest path typo
installs fine and loads nothing; that check is the only thing that notices.

## Usage

Start `pi` and ask for a spec, or invoke the author directly:

```
/skill:yamlet-author
```

The flow is unchanged from the Claude Code build. It opens by asking whether this is
a **new** spec or a **change** to one that exists, then:

- **new** — read existing scopes' summaries (`yamlet_systems` with `details: true`) to
  decide whether this belongs to a service that already exists → agree the contract →
  **contract challenge** → init → (composite: wire members);
- **change** — locate the right file the same way, then read its blast radius with
  `yamlet_impact` before proposing anything.

Both then converge: per requirement, draft → **criteria challenge** → commit → verify →
regenerate the Gherkin feature tree.

Once a spec is finished, plan the work against the code:

```
/skill:yamlet-techspec specs/pdf_upload.yamlet.yaml [code-root]
```

It opens a disposable `.techspec.yaml` (`yamlet_techspec_init`, pinned to the commit
`git` reports), runs **code research** once per requirement, records a verdict per
criterion — every `met: true` through the **evidence challenge** first — then a task
list covering every unmet criterion, and closes with `yamlet_verify` on the tech
spec. A task that needs a choice the user owns stops for one: the `yamlet-adr` skill
interviews you (**ADR challenge** after the dimensions, before any option), the
record is accepted and frozen, and `yamlet_add_adr` links it into the spec so the
tasks must cover what it obliges. `/skill:yamlet-adr adr` runs that interview on its
own.
