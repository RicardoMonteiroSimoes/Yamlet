---
name: yamlet-techspec
description: >-
  Plans one change across every finished EARS spec (.yamlet.yaml) it touches, all of one system: reads
  the code, records a verdict per acceptance criterion and per obligation of the linked ADRs, then
  one task list covering every unmet one, all through the `yamlet_techspec_*` tools into a disposable
  `.techspec.yaml`. REQUIRES one or more spec paths as arguments (e.g. `/skill:yamlet-techspec
  specs/pdf_upload.yamlet.yaml specs/pdf_verify.yamlet.yaml`); optional `--since <git-ref>` plans
  only the criteria changed since that ref, and an optional directory argument is the code root
  (default: the working directory). Use when specs are done and the question is "what is already
  there, and what do we build?". Not for writing or changing a spec — that is yamlet-author.
---

# Yamlet Tech Spec Skill

Turn **finished** specs and their code into **one tech spec**: a verdict per criterion in scope and per obligation the linked decisions place on it, then one task list covering every unmet one. You investigate; you do not implement.

## Prerequisite

This skill drives the `yamlet_techspec_*` tools from the yamlet pi extension. Without `yamlet_verify`, `yamlet_techspec_init` and friends, **stop and tell the user** to install it:

```sh
pi install git:github.com/RicardoMonteiroSimoes/Yamlet   # the extension and skills
brew install yamlet                                      # the CLI they shell out to
```

A tool that answers "missing the command(s) … techspec" means the CLI on PATH predates tech specs that span a system — relay its upgrade instruction and stop. Never fall back to `yamlet` through `bash`.

## The hard rules

- **Never write a `.yamlet.yaml`, `.techspec.yaml` or `.adr.yaml` yourself.** Every byte goes through the `yamlet_*` tools, which check each id against its spec and mint the task ids. `read` files to look at them. The extension blocks `write`/`edit` on all three, and their shell equivalents — being blocked is the rule working.
- **One plan per change.** A system's specs share one codebase. Plan every spec the change touches in one tech spec, so a shared foundation is one task and any task can depend on any other. Never run this skill once per spec for one change.
- **A tech spec is disposable.** It is planned from, implemented against, and thrown away. Tell the user to keep `*.techspec.yaml` out of version control. If a verdict was wrong, delete the file and start over — verdicts are never revised in place.
- **A verdict is a claim about code, with a reference.** `met: true` needs `evidence` (`PATH:LINE`) for where each `shall` (or an obligation's `must`) is satisfied, and it goes through the challenger first. Never mark anything met because it *should* be.

## Reading a tool's response

- `yamlet_techspec_init` returns the tech spec's path; `yamlet_techspec_task` returns its `T-N`. A `DECIDED:` notice in the result means an ADR decides this behaviour — see *Decided behaviour*.
- A failure (`error:`) wrote nothing. It names what is missing, out of order, or which ids and specs exist; fix the input. A refusal that says the file has errors means delete it and start over.

## Working rhythm

1. **Arguments.** Every `*.yamlet.yaml` is a spec; a directory is the code root; `--since REF` asks for a diff plan. Specs of different systems are two plans: stop and ask which one first.
2. **Complete the set.** `yamlet_systems({ dir: <specs dir>, system: <slug> })` lists the system's other scopes. Unless the user already named them, ask once whether this change touches any of them too; add those the user names.
3. **Gate.** `yamlet_verify({ file: SPEC })` must report `OK` for each. If not, stop: that spec is not finished; route the user to `yamlet-author`.
4. **Scope — only with `--since`.** Per spec, `git diff REF -- SPEC` (`git show REF:SPEC` for the old version). A spec new since REF is planned whole. Otherwise its scope is every criterion that is new or whose pattern, clauses, `shall` or examples changed, and every criterion of a new requirement; a spec with none drops out. A criterion removed since REF cannot be scoped — list it for the report. Ids are permanent, so match by id, never by position.
5. **Open.** `yamlet_techspec_init({ specs: [SPEC, ...], scope: ["SPEC#AC-N", ...] })` returns the path — use it as `TS` below (`SPEC#RQ-N` in `scope` takes a whole requirement). `already plans <system>` means a plan for this system is open: ask the user whether to finish it or delete it — never delete it yourself. Then pin the code: `yamlet_techspec_analysis({ file: TS, code_root: ROOT })`. The tool reads the commit from `git` in the code root itself; pass `commit` only when the user names a different one.
6. **Read.** `read` each spec once: the contract (`exposes`), every `RQ-N`, every `AC-N` in scope with its pattern, clauses and `shall` list, and any `adrs:` links. `read` every record linked on a criterion in scope or on its requirement, and note each accepted one's `requires` (`R-n`) — those are the obligations the plan owes. `yamlet_verify({ file: TS })` lists what is still owed: E706 per criterion, E716 per obligation.
7. **Research, one requirement at a time** (only requirements with a criterion in scope). Spawn the **`yamlet-code-research`** agent with: the code root, the contract, the requirement with its in-scope criteria verbatim, and the obligations of the records deciding it (`ADR-nnnn#R-n` + `must`).

   ```
   Agent({
     subagent_type: "yamlet-code-research",
     description: "Research RQ-N",
     prompt: "<code root + contract + RQ-N with every in-scope AC verbatim + its obligations>"
   })
   ```

   It returns, per item, where the behaviour lives (`file:line`), what the code does there, deviations, related tests, and which directories it read closely or skimmed. Record the directories: `yamlet_techspec_analysis({ file: TS, deep: [...], skimmed: [...] })` (lists accumulate).
8. **Verdicts.** Decide `met: true` only when *every* `shall` (or the `must`) is observably satisfied at a cited reference; a partial, a wrong value, or the right place with the wrong behaviour is `met: false` with the references as evidence and a one-line `note` saying what differs. **Before recording `met: true`**, spawn the **`yamlet-evidence-challenger`** agent with the code root, the criterion or obligation verbatim and the exact references. It starts from a fresh context and can only `read`, so a reference it cannot resolve from the root you give is a refutation — always pass the root. `REFUTED` → record `met: false` with its reason as the note.
   `yamlet_techspec_criterion({ file: TS, ac: "SPEC#AC-N", met: true|false, evidence: ["PATH:LINE", ...], note: "..." })`
   `yamlet_techspec_obligation({ file: TS, of: "ADR-nnnn#R-n", met: true|false, evidence: [...], note: "..." })`
   An obligation the code already discharges is **met, with evidence** — never a task written to say so.
9. **Decisions before tasks.** For every unmet item ask: can the work be broken down without a choice the user owns — a library, a protocol, isolation, storage, a trade-off? If not, load `yamlet_guide({ topic: "decisions" })` and run that gate *now*. It ends with an accepted record linked into the spec by `yamlet_add_adr`; its obligations then need verdicts too.
10. **Tasks, across the whole plan.** First look across every unmet item for what they share — a table, a clock, a guard, a client — and make each shared thing **one** task, never one per spec. Enablers first (`why`, no `covers`), so later tasks can `depends_on` them; then one task per coherent change, `covers` every unmet criterion (`SPEC#AC-N`) and obligation (`ADR-nnnn#R-n`) it satisfies, `depends_on` what must land first, whichever spec it serves. A title states the behaviour the task delivers, not the activity.
    `yamlet_techspec_task({ file: TS, title: "...", covers: ["SPEC#AC-N", "ADR-nnnn#R-n"], depends_on: ["T-N"], why: "..." })`
11. **Close.** `yamlet_verify({ file: TS })` must report `OK` — every criterion in scope and every owed obligation has one verdict, met ones cite evidence, every unmet one is covered, and dependencies resolve. Then report to the user (below).

`SPEC` in `ac` and `covers` is the path as `init` listed it, or any path to the same file; with a single spec a bare `AC-N` will do.

### If there is no `Agent` tool

The research and the gate need [`@tintinweb/pi-subagents`](https://pi.dev/packages/@tintinweb/pi-subagents). Without it, do not skip them. Tell the user once that you are doing the research and the evidence check inline, in your own context, and that it is a weaker check. Then work the real procedures — `yamlet_guide({ topic: "code-research" })` and `yamlet_guide({ topic: "evidence-challenge" })` — never your memory of them, and report in the same shape. Be harder on yourself to compensate: inline, you are checking your own reading.

## Decided behaviour

A `DECIDED:` notice lists the records behind a criterion and, for an accepted one, the obligations still without a verdict. **`read` the records before going on**; the verdict and the covering task must fit them. If one no longer holds, that is a decision to revisit through `yamlet_guide({ topic: "decisions" })`, never a task.

## Report

In prose, in dependency order: each task, what it delivers, which criteria and obligations it covers and in which spec; the criteria and obligations found met; every ADR written or read. With `--since`, name the scope per spec and every criterion removed since REF (the code behind it may need to go; that is the user's call, not a task here). Name the file, say it is disposable and belongs in `.gitignore`.

To show the plan in context — criteria, verdicts, ADRs and tasks in one navigable page — offer `yamlet_trace({ dir: <specs dir>, out: "trace.html" })` (add `techspec: [TS]` if TS lies outside that dir). Hand the user the path; **never `read` it back**.

## When a spec changes later

A changed spec means a new plan: delete the old tech spec once its work is done, then run this skill with `--since` the commit the old plan was pinned to. `yamlet-author` relays a `WARNING` when it adds a criterion under a decided requirement; that warning names this skill as the step that accounts for the decision.
