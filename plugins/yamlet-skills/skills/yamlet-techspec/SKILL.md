---
name: yamlet-techspec
description: >-
  Plans the work for a finished EARS spec (.yamlet.yaml): reads the code it should implement, records
  a verdict per acceptance criterion, then a task list covering every unmet one, all through
  `yamlet techspec` into a disposable `.techspec.yaml`. REQUIRES the spec's path as its argument
  (e.g. `/yamlet-techspec specs/pdf_upload.yamlet.yaml`); an optional second argument is the code
  root (default: the working directory). Use when a spec is done and the question is "what is
  already there, and what do we build?". Not for writing or changing a spec — that is yamlet-author.
argument-hint: <path/to/spec.yamlet.yaml> [code-root]
allowed-tools: Bash(yamlet:*), Bash(git rev-parse:*), Read, Write, Skill(yamlet-code-research *), Skill(yamlet-skills:yamlet-code-research *), Skill(yamlet-evidence-challenger *), Skill(yamlet-skills:yamlet-evidence-challenger *)
---

# Yamlet Tech Spec Skill

Turn a **finished** spec and its code into a **tech spec**: a verdict per criterion, then tasks covering every unmet one. You investigate; you do not implement.

## The hard rules

- **Never write a `.yamlet.yaml` or `.techspec.yaml` yourself** — no Write, no Edit, no shell redirection. Every byte goes through `yamlet`, which checks each id against the spec and mints the task ids. `Read` files to look at them. The only file you may write is an ADR (below).
- **A tech spec is disposable.** It is planned from, implemented against, and thrown away. Tell the user to keep `*.techspec.yaml` out of version control. If a verdict was wrong, delete the file and start over — verdicts are never revised in place.
- **A verdict is a claim about code, with a reference.** `met: true` needs `--evidence PATH:LINE` for where each `shall` is satisfied, and it goes through the challenger first. Never mark a criterion met because it *should* be.

## Reading the tool's response

- **exit 0** — `init` prints the tech spec's path; `task` prints its `T-N`. A `DECIDED:` notice on stderr means an ADR decides this behaviour — see *Decided behaviour*.
- **exit 2** — `error:` and nothing was written. Fix the input; a refusal names the ids that exist.
- **exit 3** — the change tripped a validation finding and was not written. Tell the user.

## Working rhythm

1. **Gate.** `yamlet verify SPEC` must print `OK`. If not, stop: the spec is not finished; route the user to `yamlet-author`.
2. **Open.** `yamlet techspec init SPEC` (prints the path — use it as `TS` below). Then pin the code: `git rev-parse --short HEAD` in the code root, and `yamlet techspec analysis TS --commit SHA`.
3. **Read the spec.** `Read` it once. Note the contract (`exposes`), every `RQ-N`, every `AC-N` with its pattern, clauses and `shall` list, and any `adrs:` links.
4. **Research, one requirement at a time.** Invoke **`yamlet-code-research`** (`/yamlet-code-research <input>`) with: the code root, the contract, and the requirement with all its criteria verbatim. It returns, per criterion, where the behaviour lives (`file:line`), what the code does there, deviations from each `shall`, related tests, and which directories it read closely or skimmed. Record the directories: `yamlet techspec analysis TS --deep DIR --skimmed DIR` (lists accumulate).
5. **Verdicts, per criterion, in spec order.** From the research decide `met: true` only when *every* `shall` is observably satisfied at a cited reference; a partial, a wrong value, or the right place with the wrong behaviour is `met: false` with the references as evidence and a one-line `--note` saying what differs. **Before recording `met: true`**, invoke **`yamlet-evidence-challenger`** (`/yamlet-evidence-challenger <input>`) with the criterion verbatim and the exact references. `REFUTED` → record `met: false` with its reason as the note. Then:
   `yamlet techspec criterion TS --ac AC-N --met true|false [--evidence PATH:LINE ...] [--note "..."]`
6. **Decisions before tasks.** For every unmet criterion ask: can the work be broken down without a choice the user owns — a library, a protocol, isolation, storage, a trade-off? If not, run the gate in `references/decisions.md` *now*. It ends with an ADR on disk and `yamlet add-adr` linking it into the spec.
7. **Tasks.** Enablers first (`--why`, no `--covers`), so later tasks can `--depends-on` them; then one task per coherent change, `--covers` the unmet criteria it satisfies, `--depends-on` what must land first. A title states the behaviour the task delivers, not the activity. Every unmet criterion must end up covered.
   `yamlet techspec task TS --title "..." [--covers AC-N ...] [--depends-on T-N ...] [--why "..."]`
8. **Close.** `yamlet verify TS` must print `OK` — it proves every criterion has one verdict, met ones cite evidence, every unmet one is covered, and dependencies resolve. Then report to the user (below).

## Decided behaviour

A `DECIDED:` notice lists the ADRs behind a criterion. **`Read` them before going on**; the verdict and the covering task must fit them. If they no longer hold, that is a decision to revisit through `references/decisions.md`, never a task.

## Report

In prose, in dependency order: each task, what it delivers, which criteria it covers; the criteria found met; every ADR written or read. Name the file, say it is disposable and belongs in `.gitignore`.

## When the spec changes later

A changed spec means a new tech spec: delete the old file and run this skill again. `yamlet-author` prints a `WARNING` when it adds a criterion under a decided requirement; that warning names this skill as the step that accounts for the decision.
