---
name: yamlet-techspec
description: >-
  Plans one change across every finished EARS spec (.yamlet.yaml) it touches, all of one system: reads
  the code, records a verdict per acceptance criterion and per obligation of the linked ADRs, then
  one task list covering every unmet one, all through {{ `yamlet techspec` || the `yamlet_techspec_*` tools }} into a disposable
  `.techspec.yaml`. REQUIRES one or more spec paths as arguments (e.g. `{{invoke yamlet-techspec}}
  specs/pdf_upload.yamlet.yaml specs/pdf_verify.yamlet.yaml`); optional `--since <git-ref>` plans only
  the criteria changed since that ref, and an optional directory argument is the code root (default:
  the working directory). Use when specs are done and the question is "what is already there, and
  what do we build?". Not for writing or changing a spec — that is yamlet-author.
tools: [yamlet, git:rev-parse, git:diff, git:show, read]
invokes: [yamlet-code-research, yamlet-evidence-challenger, yamlet-adr, yamlet-refresh]
claude:
  argument-hint: <spec.yamlet.yaml>... [--since <git-ref>] [code-root]
---

# Yamlet Tech Spec Skill

Turn **finished** specs and their code into **one tech spec**: a verdict per criterion in scope and per obligation the linked decisions place on it, then one task list covering every unmet one. You investigate; you do not implement.

{{#pi}}
## Prerequisite

This skill drives the `yamlet_techspec_*` tools from the yamlet pi extension. Without `yamlet_verify`, `yamlet_techspec_init` and friends, **stop and tell the user** to install it:

```sh
pi install git:github.com/RicardoMonteiroSimoes/Yamlet   # the extension and skills
brew install yamlet                                      # the CLI they shell out to
```

A tool that answers "missing the command(s) … techspec" means the CLI on PATH predates tech specs that span a system — relay its upgrade instruction and stop. Never fall back to `yamlet` through `bash`.

{{/pi}}
## The hard rules

- **Never write a `.yamlet.yaml`, `.techspec.yaml` or `.adr.yaml` {{ yourself** — no Write, no Edit, no shell redirection. || yourself.** }} Every byte goes through {{ `yamlet`, which checks each id against its spec and mints || the `yamlet_*` tools, which check each id against its spec and mint }} the task ids. {{ `Read` || `read` }} files to look at them.{{#pi}} The extension blocks `write`/`edit` on all three, and their shell equivalents — being blocked is the rule working.{{/pi}}
- **One plan per change.** A system's specs share one codebase. Plan every spec the change touches in one tech spec, so a shared foundation is one task and any task can depend on any other. Never run this skill once per spec for one change.
- **A tech spec is disposable.** It is planned from, implemented against, and thrown away. Tell the user to keep `*.techspec.yaml` out of version control. If a verdict was wrong, delete the file and start over — verdicts are never revised in place.
- **A verdict is a claim about code, with a reference.** `met: true` needs {{ `--evidence PATH:LINE` || `evidence` (`PATH:LINE`) }} for where each `shall` (or an obligation's `must`) is satisfied, and it goes through the challenger first. Never mark anything met because it *should* be.

## Reading {{ the || a }} tool's response

{{#claude}}
- **exit 0** — `init` prints the tech spec's path; `task` prints its `T-N`. A `DECIDED:` notice on stderr means an ADR decides this behaviour — see *Decided behaviour*.
- **exit 2** — `error:` and nothing was written. Fix the input; a refusal names the ids and specs that exist. A refusal that says the file has errors means delete it and start over.
- **exit 3** — the change tripped a validation finding and was not written. Tell the user.
{{/claude}}
{{#pi}}
- `yamlet_techspec_init` returns the tech spec's path; `yamlet_techspec_task` returns its `T-N`. A `DECIDED:` notice in the result means an ADR decides this behaviour — see *Decided behaviour*.
- A failure (`error:`) wrote nothing. It names what is missing, out of order, or which ids and specs exist; fix the input. A refusal that says the file has errors means delete it and start over. A failure saying the change "produced an unexpected finding (nothing written)" is the commit gate: tell the user.
{{/pi}}

## Working rhythm

1. **Arguments.** Every `*.yamlet.yaml` is a spec; a directory is the code root; `--since REF` asks for a diff plan. Specs of different systems are two plans: stop and ask which one first.
2. **Complete the set.** `{{cmd systems <specs-dir> --system=<slug>}}` lists the system's other scopes. Unless the user already named them, ask once whether this change touches any of them too; add those the user names.
3. **Gate.** `{{cmd verify SPEC}}` must {{ print || report }} `OK` for each. If not, stop: that spec is not finished; route the user to `yamlet-author`.
4. **Scope — only with `--since`.** Per spec, `git diff REF -- SPEC` (`git show REF:SPEC` to read the old version). A spec new since REF is planned whole. Otherwise its scope is every criterion that is new or whose pattern, clauses, `shall` or examples changed, and every criterion of a new requirement; a spec with none drops out. A criterion removed since REF cannot be scoped — list it for the report. Ids are permanent, so match by id, never by position.
5. **Open.** `{{cmd techspec init SPEC... [--scope SPEC#AC-N ...]}}` {{ (prints the path — use it as `TS` below; `--scope SPEC#RQ-N` takes a whole requirement) || returns the path — use it as `TS` below (`SPEC#RQ-N` in `scope` takes a whole requirement) }}. `already plans <system>` means a plan for this system is open: ask the user whether to finish it or delete it — never delete it yourself. Then pin the code: {{ `git rev-parse --short HEAD` in the code root, and `yamlet techspec analysis TS --commit SHA`. || `yamlet_techspec_analysis({ file: TS, code_root: ROOT })`. The tool reads the commit from `git` in the code root itself; pass `commit` only when the user names a different one. }}
6. **Read.** {{ `Read` || `read` }} each spec once: the contract (`exposes`), every `RQ-N`, every `AC-N` in scope with its pattern, clauses and `shall` list, and any `adrs:` links. {{ `Read` || `read` }} every record linked on a criterion in scope or on its requirement, and note each accepted one's `requires` (`R-n`) — those are the obligations the plan owes. `{{cmd verify TS}}` lists what is still owed: E706 per criterion, E716 per obligation.
7. **Research, one requirement at a time** (only requirements with a criterion in scope). {{ Invoke **`yamlet-code-research`** (`/yamlet-code-research <input>`) || Spawn the **`yamlet-code-research`** agent }} with: the code root, the contract, the requirement with its in-scope criteria verbatim (with `reads`/`writes`), and the obligations of the records deciding it (`ADR-nnnn#R-n` + `must`).
{{#pi}}

   ```
   Agent({
     subagent_type: "yamlet-code-research",
     description: "Research RQ-N",
     prompt: "<code root + contract + RQ-N with every in-scope AC verbatim + its obligations>"
   })
   ```
{{/pi}}

   It returns, per item, where the behaviour lives (`file:line`), what the code does there, deviations, related tests, the stored state the criteria touch, and which directories it read closely or skimmed. Record the directories: `{{cmd techspec analysis TS --deep DIR --skimmed DIR}}` (lists accumulate).
8. **Verdicts.** Decide `met: true` only when *every* `shall` (or the `must`) is observably satisfied at a cited reference; a partial, a wrong value, or the right place with the wrong behaviour is `met: false` with the references as evidence and a one-line `{{flag --note}}` saying what differs. **Before recording `met: true`**, {{ invoke **`yamlet-evidence-challenger`** (`/yamlet-evidence-challenger <input>`) with the criterion || spawn the **`yamlet-evidence-challenger`** agent with the code root, the criterion }} or obligation verbatim (with its `writes`) and the exact references.{{#pi}} It starts from a fresh context and can only `read`, so a reference it cannot resolve from the root you give is a refutation — always pass the root.{{/pi}} `REFUTED` → record `met: false` with its reason as the note.
   `{{cmd techspec criterion TS --ac SPEC#AC-N --met true|false [--evidence PATH:LINE ...] [--note "..."]}}`
   `{{cmd techspec obligation TS --of ADR-nnnn#R-n --met true|false [--evidence PATH:LINE ...] [--note "..."]}}`
   An obligation the code already discharges is **met, with evidence** — never a task written to say so.
9. **State inventory** (working notes). The fields the criteria in scope declare, plus `{{cmd systems DIR --system=S --state}}` for the rest of the system; each research STATE adds where the code declares it, or `absent`. Absent or unusable → schema work for step 11. Two scopes on one field, one writing → a **contended pair** for step 10. UNDECLARED state → spec gap: route to {{ `yamlet-author` (`add-state`) || the `yamlet-author` skill (`yamlet_add_state`) }}.
10. **Decisions before tasks.** For every unmet item ask: can the work be broken down without a choice the user owns — a library, a protocol, isolation, storage, a trade-off? For every contended pair, also ask how the two interleave — a vote landing after the poll closed, an option removed while it is voted on. If no criterion says what happens then, the spec has a gap: stop and route the user to `yamlet-author`. If one does, how to enforce it — locking, isolation, ordering — is a choice. Collation, keys, cascades and id formats come here only when the user owns the choice; otherwise the schema task settles them. Where a choice remains, {{ run the gate in `{{ref decisions}}` || load `{{ref decisions}}` and run that gate }} *now*. It ends with an accepted record linked into the spec by `{{tool add-adr}}`; its obligations then need verdicts too.
11. **Tasks, across the whole plan.** First look across every unmet item for what they share — a table, a clock, a guard, a client — and make each shared thing **one** task, never one per spec. Schema work from the inventory is one enabler per entity, which every task using its fields depends on; a new column satisfies no `shall` on its own, so it covers nothing. Enablers first (`{{flag --why}}`, no `{{flag --covers}}`), so later tasks can `{{flag --depends-on}}` them; then one task per coherent change, `{{flag --covers}}` every unmet criterion (`SPEC#AC-N`) and obligation (`ADR-nnnn#R-n`) it satisfies, `{{flag --depends-on}}` what must land first, whichever spec it serves. A title states the behaviour the task delivers, not the activity.
    `{{cmd techspec task TS --title "..." [--covers SPEC#AC-N|ADR-nnnn#R-n ...] [--depends-on T-N ...] [--why "..."]}}`
12. **Close.** `{{cmd verify TS}}` must {{ print || report }} `OK` — every criterion in scope and every owed obligation has one verdict, met ones cite evidence, every unmet one is covered, and dependencies resolve. Then report to the user (below).

`SPEC` {{ on the command line || in `ac` and `covers` }} is the path as `init` listed it, or any path to the same file; with a single spec a bare `AC-N` will do.
{{#pi}}

### If there is no `Agent` tool

The research and the gate need [`@tintinweb/pi-subagents`](https://pi.dev/packages/@tintinweb/pi-subagents). Without it, do not skip them. Tell the user once that you are doing the research and the evidence check inline, in your own context, and that it is a weaker check. Then work the real procedures — `{{ref code-research}}` and `{{ref evidence-challenge}}` — never your memory of them, and report in the same shape. Be harder on yourself to compensate: inline, you are checking your own reading.
{{/pi}}

## Decided behaviour

A `DECIDED:` notice lists the records behind a criterion and, for an accepted one, the obligations still without a verdict. **{{ `Read` || `read` }} the records before going on**; the verdict and the covering task must fit them. If one no longer holds, that is a decision to revisit through `{{ref decisions}}`, never a task.

## Report

In prose, in dependency order: each task, what it delivers, which criteria and obligations it covers and in which spec; the criteria and obligations found met; every ADR written or read; each contended pair and how it was settled. With `--since`, name the scope per spec and every criterion removed since REF (the code behind it may need to go; that is the user's call, not a task here). Name the file, say it is disposable and belongs in `.gitignore`.

To show the plan in context — criteria, verdicts, ADRs and tasks in one navigable page — offer `{{cmd trace <specs-dir> --out=trace.html}}` (add {{ `--techspec=TS` || `techspec: [TS]` }} if TS lies outside that dir). Hand the user the path; **never {{ `Read` || `read` }} it back**.

## When a spec changes later

A changed spec means a new plan: delete the old tech spec once its work is done, then run this skill with `--since` the commit the old plan was pinned to. `yamlet-author` {{ prints || relays }} a `WARNING` when it adds a criterion under a decided requirement; that warning names this skill as the step that accounts for the decision.
