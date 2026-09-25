---
name: yamlet-techspec
description: >-
  Plans one change across every finished EARS spec (.yamlet.yaml) it touches, all of one system: reads
  the code, records a verdict per acceptance criterion and per obligation of the linked ADRs, then
  one task list covering every unmet one, all through `yamlet techspec` into a disposable
  `.techspec.yaml`. REQUIRES one or more spec paths as arguments (e.g. `/yamlet-techspec
  specs/pdf_upload.yamlet.yaml specs/pdf_verify.yamlet.yaml`); optional `--since <git-ref>` plans only
  the criteria changed since that ref, and an optional directory argument is the code root (default:
  the working directory). Use when specs are done and the question is "what is already there, and
  what do we build?". Not for writing or changing a spec — that is yamlet-author.
argument-hint: <spec.yamlet.yaml>... [--since <git-ref>] [code-root]
allowed-tools: Bash(yamlet:*), Bash(git rev-parse:*), Bash(git diff:*), Bash(git show:*), Read, Skill(yamlet-code-research *), Skill(yamlet-skills:yamlet-code-research *), Skill(yamlet-evidence-challenger *), Skill(yamlet-skills:yamlet-evidence-challenger *), Skill(yamlet-adr *), Skill(yamlet-skills:yamlet-adr *)
---

# Yamlet Tech Spec Skill

Turn **finished** specs and their code into **one tech spec**: a verdict per criterion in scope and per obligation the linked decisions place on it, then one task list covering every unmet one. You investigate; you do not implement.

## The hard rules

- **Never write a `.yamlet.yaml`, `.techspec.yaml` or `.adr.yaml` yourself** — no Write, no Edit, no shell redirection. Every byte goes through `yamlet`, which checks each id against its spec and mints the task ids. `Read` files to look at them.
- **One plan per change.** A system's specs share one codebase. Plan every spec the change touches in one tech spec, so a shared foundation is one task and any task can depend on any other. Never run this skill once per spec for one change.
- **A tech spec is disposable.** It is planned from, implemented against, and thrown away. Tell the user to keep `*.techspec.yaml` out of version control. If a verdict was wrong, delete the file and start over — verdicts are never revised in place.
- **A verdict is a claim about code, with a reference.** `met: true` needs `--evidence PATH:LINE` for where each `shall` (or an obligation's `must`) is satisfied, and it goes through the challenger first. Never mark anything met because it *should* be.

## Reading the tool's response

- **exit 0** — `init` prints the tech spec's path; `task` prints its `T-N`. A `DECIDED:` notice on stderr means an ADR decides this behaviour — see *Decided behaviour*.
- **exit 2** — `error:` and nothing was written. Fix the input; a refusal names the ids and specs that exist. A refusal that says the file has errors means delete it and start over.
- **exit 3** — the change tripped a validation finding and was not written. Tell the user.

## Working rhythm

1. **Arguments.** Every `*.yamlet.yaml` is a spec; a directory is the code root; `--since REF` asks for a diff plan. Specs of different systems are two plans: stop and ask which one first.
2. **Complete the set.** `yamlet systems <specs dir> --system=<slug>` lists the system's other scopes. Unless the user already named them, ask once whether this change touches any of them too; add those the user names.
3. **Gate.** `yamlet verify SPEC` must print `OK` for each. If not, stop: that spec is not finished; route the user to `yamlet-author`.
4. **Scope — only with `--since`.** Per spec, `git diff REF -- SPEC` (`git show REF:SPEC` to read the old version). A spec new since REF is planned whole. Otherwise its scope is every criterion that is new or whose pattern, clauses, `shall` or examples changed, and every criterion of a new requirement; a spec with none drops out. A criterion removed since REF cannot be scoped — list it for the report. Ids are permanent, so match by id, never by position.
5. **Open.** `yamlet techspec init SPEC... [--scope SPEC#AC-N ...]` (prints the path — use it as `TS` below; `--scope SPEC#RQ-N` takes a whole requirement). `already plans <system>` means a plan for this system is open: ask the user whether to finish it or delete it — never delete it yourself. Then pin the code: `git rev-parse --short HEAD` in the code root, and `yamlet techspec analysis TS --commit SHA`.
6. **Read.** `Read` each spec once: the contract (`exposes`), every `RQ-N`, every `AC-N` in scope with its pattern, clauses and `shall` list, and any `adrs:` links. `Read` every record linked on a criterion in scope or on its requirement, and note each accepted one's `requires` (`R-n`) — those are the obligations the plan owes. `yamlet verify TS` lists what is still owed: E706 per criterion, E716 per obligation.
7. **Research, one requirement at a time** (only requirements with a criterion in scope). Invoke **`yamlet-code-research`** (`/yamlet-code-research <input>`) with: the code root, the contract, the requirement with its in-scope criteria verbatim, and the obligations of the records deciding it (`ADR-nnnn#R-n` + `must`). It returns, per item, where the behaviour lives (`file:line`), what the code does there, deviations, related tests, the stored state the criteria touch, and which directories it read closely or skimmed. Record the directories: `yamlet techspec analysis TS --deep DIR --skimmed DIR` (lists accumulate).
8. **Verdicts.** Decide `met: true` only when *every* `shall` (or the `must`) is observably satisfied at a cited reference; a partial, a wrong value, or the right place with the wrong behaviour is `met: false` with the references as evidence and a one-line `--note` saying what differs. **Before recording `met: true`**, invoke **`yamlet-evidence-challenger`** (`/yamlet-evidence-challenger <input>`) with the criterion or obligation verbatim and the exact references. `REFUTED` → record `met: false` with its reason as the note.
   `yamlet techspec criterion TS --ac SPEC#AC-N --met true|false [--evidence PATH:LINE ...] [--note "..."]`
   `yamlet techspec obligation TS --of ADR-nnnn#R-n --met true|false [--evidence PATH:LINE ...] [--note "..."]`
   An obligation the code already discharges is **met, with evidence** — never a task written to say so.
9. **State inventory, across the whole plan.** Merge every research report's STATE into one list — working notes, not a file: each entity and field the criteria in scope read or write, where the code declares it or `absent`, and every requirement, in any spec of the plan, that writes it. A field that is absent, or declared in a way a criterion cannot use, is schema work for step 11. A field written by two or more requirements is a **shared write** for step 10.
10. **Decisions before tasks.** For every unmet item ask: can the work be broken down without a choice the user owns — a library, a protocol, isolation, storage, a trade-off? For every shared write, also ask how its writers interleave — a vote landing after the poll closed, an option removed while it is voted on. If no criterion says what happens then, the spec has a gap: stop and route the user to `yamlet-author`. If one does, how to enforce it — locking, isolation, ordering — is a choice. Collation, keys, cascades and id formats come here only when the user owns the choice; otherwise the schema task settles them. Where a choice remains, run the gate in `references/decisions.md` *now*. It ends with an accepted record linked into the spec by `yamlet add-adr`; its obligations then need verdicts too.
11. **Tasks, across the whole plan.** First look across every unmet item for what they share — a table, a clock, a guard, a client — and make each shared thing **one** task, never one per spec. Schema work from the inventory is one enabler per entity, which every task using its fields depends on; a new column satisfies no `shall` on its own, so it covers nothing. Enablers first (`--why`, no `--covers`), so later tasks can `--depends-on` them; then one task per coherent change, `--covers` every unmet criterion (`SPEC#AC-N`) and obligation (`ADR-nnnn#R-n`) it satisfies, `--depends-on` what must land first, whichever spec it serves. A title states the behaviour the task delivers, not the activity.
    `yamlet techspec task TS --title "..." [--covers SPEC#AC-N|ADR-nnnn#R-n ...] [--depends-on T-N ...] [--why "..."]`
12. **Close.** `yamlet verify TS` must print `OK` — every criterion in scope and every owed obligation has one verdict, met ones cite evidence, every unmet one is covered, and dependencies resolve. Then report to the user (below).

`SPEC` on the command line is the path as `init` listed it, or any path to the same file; with a single spec a bare `AC-N` will do.

## Decided behaviour

A `DECIDED:` notice lists the records behind a criterion and, for an accepted one, the obligations still without a verdict. **`Read` the records before going on**; the verdict and the covering task must fit them. If one no longer holds, that is a decision to revisit through `references/decisions.md`, never a task.

## Report

In prose, in dependency order: each task, what it delivers, which criteria and obligations it covers and in which spec; the criteria and obligations found met; every ADR written or read; each shared write and how it was settled. With `--since`, name the scope per spec and every criterion removed since REF (the code behind it may need to go; that is the user's call, not a task here). Name the file, say it is disposable and belongs in `.gitignore`.

To show the plan in context — criteria, verdicts, ADRs and tasks in one navigable page — offer `yamlet trace <specs dir> --out=trace.html` (add `--techspec=TS` if TS lies outside that dir). Hand the user the path; **never `Read` it back**.

## When a spec changes later

A changed spec means a new plan: delete the old tech spec once its work is done, then run this skill with `--since` the commit the old plan was pinned to. `yamlet-author` prints a `WARNING` when it adds a criterion under a decided requirement; that warning names this skill as the step that accounts for the decision.
