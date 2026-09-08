---
name: yamlet-techspec
description: >-
  Plans the work for a finished EARS spec (.yamlet.yaml): reads the code it should implement, records
  a verdict per acceptance criterion, then a task list covering every unmet one, all through the
  `yamlet_techspec_*` tools into a disposable `.techspec.yaml`. REQUIRES the spec's path as its
  argument (e.g. `/skill:yamlet-techspec specs/pdf_upload.yamlet.yaml`); an optional second argument
  is the code root (default: the working directory). Use when a spec is done and the question is
  "what is already there, and what do we build?". Not for writing or changing a spec — that is
  yamlet-author.
---

# Yamlet Tech Spec Skill

Turn a **finished** spec and its code into a **tech spec**: a verdict per criterion, then tasks covering every unmet one. You investigate; you do not implement.

## Prerequisite

This skill drives the `yamlet_techspec_*` tools from the yamlet pi extension. Without `yamlet_verify`, `yamlet_techspec_init` and friends, **stop and tell the user** to install it:

```sh
pi install git:github.com/RicardoMonteiroSimoes/Yamlet   # the extension and skills
brew install yamlet                                      # the CLI they shell out to
```

A tool that answers "missing the command(s) … techspec" means the CLI on PATH predates tech specs — relay its upgrade instruction and stop. Never fall back to `yamlet` through `bash`.

## The hard rules

- **Never write a `.yamlet.yaml`, `.techspec.yaml` or `.adr.yaml` yourself.** Every byte goes through the `yamlet_*` tools, which check each id against the spec and mint the task ids. `read` files to look at them. The extension blocks `write`/`edit` on all three, and their shell equivalents — being blocked is the rule working.
- **A tech spec is disposable.** It is planned from, implemented against, and thrown away. Tell the user to keep `*.techspec.yaml` out of version control. If a verdict was wrong, delete the file and start over — verdicts are never revised in place.
- **A verdict is a claim about code, with a reference.** `met: true` needs `evidence` (`PATH:LINE`) for where each `shall` is satisfied, and it goes through the challenger first. Never mark a criterion met because it *should* be.

## Reading a tool's response

- `yamlet_techspec_init` returns the tech spec's path; `yamlet_techspec_task` returns its `T-N`. A `DECIDED:` notice in the result means an ADR decides this behaviour — see *Decided behaviour*.
- A failure (`error:`) wrote nothing. It names what is missing, out of order, or which ids exist; fix the input. A refusal that says the file has errors means delete it and start over.

## Working rhythm

1. **Gate.** `yamlet_verify({ file: SPEC })` must report `OK`. If not, stop: the spec is not finished; route the user to `yamlet-author`.
2. **Open.** `yamlet_techspec_init({ spec: SPEC })` returns the path — use it as `TS` below. Then pin the code: `yamlet_techspec_analysis({ file: TS, code_root: ROOT })`. The tool reads the commit from `git` in the code root itself; pass `commit` only when the user names a different one.
3. **Read the spec.** `read` it once. Note the contract (`exposes`), every `RQ-N`, every `AC-N` with its pattern, clauses and `shall` list, and any `adrs:` links.
4. **Research, one requirement at a time.** Spawn the **`yamlet-code-research`** agent with: the code root, the contract, and the requirement with all its criteria verbatim.

   ```
   Agent({
     subagent_type: "yamlet-code-research",
     description: "Research RQ-N",
     prompt: "<code root + contract + RQ-N with every AC verbatim>"
   })
   ```

   It returns, per criterion, where the behaviour lives (`file:line`), what the code does there, deviations from each `shall`, related tests, and which directories it read closely or skimmed. Record the directories: `yamlet_techspec_analysis({ file: TS, deep: [...], skimmed: [...] })` (lists accumulate).
5. **Verdicts, per criterion, in spec order.** From the research decide `met: true` only when *every* `shall` is observably satisfied at a cited reference; a partial, a wrong value, or the right place with the wrong behaviour is `met: false` with the references as evidence and a one-line `note` saying what differs. **Before recording `met: true`**, spawn the **`yamlet-evidence-challenger`** agent with the criterion verbatim and the exact references. `REFUTED` → record `met: false` with its reason as the note. Then:
   `yamlet_techspec_criterion({ file: TS, ac: "AC-N", met: true|false, evidence: ["PATH:LINE", ...], note: "..." })`
6. **Decisions before tasks.** For every unmet criterion ask: can the work be broken down without a choice the user owns — a library, a protocol, isolation, storage, a trade-off? If not, load `yamlet_guide({ topic: "decisions" })` and run that gate *now*. It ends with an accepted record linked into the spec by `yamlet_add_adr`.
7. **Tasks.** Enablers first (`why`, no `covers`), so later tasks can `depends_on` them; then one task per coherent change, `covers` the unmet criteria it satisfies and the obligations (`ADR-nnnn#R-n`) it discharges, `depends_on` what must land first. A title states the behaviour the task delivers, not the activity. Every unmet criterion and every obligation of an accepted linked record must end up covered.
   `yamlet_techspec_task({ file: TS, title: "...", covers: ["AC-N", "ADR-nnnn#R-n"], depends_on: ["T-N"], why: "..." })`
8. **Close.** `yamlet_verify({ file: TS })` must report `OK` — it proves every criterion has one verdict, met ones cite evidence, every unmet criterion and obligation is covered, and dependencies resolve. Then report to the user (below).

### If there is no `Agent` tool

The research and the gate need [`@tintinweb/pi-subagents`](https://pi.dev/packages/@tintinweb/pi-subagents). Without it, do not skip them. Tell the user once that you are doing the research and the evidence check inline, in your own context, and that it is a weaker check. Then work the real procedures — `yamlet_guide({ topic: "code-research" })` and `yamlet_guide({ topic: "evidence-challenge" })` — never your memory of them, and report in the same shape. Be harder on yourself to compensate: inline, you are checking your own reading.

## Decided behaviour

A `DECIDED:` notice lists the records behind a criterion and, for an accepted one, the obligations to cover. **`read` the records before going on**; the verdict and the covering task must fit them. If one no longer holds, that is a decision to revisit through `yamlet_guide({ topic: "decisions" })`, never a task.

## Report

In prose, in dependency order: each task, what it delivers, which criteria it covers; the criteria found met; every ADR written or read. Name the file, say it is disposable and belongs in `.gitignore`.

## When the spec changes later

A changed spec means a new tech spec: delete the old file and run this skill again. `yamlet-author` relays a `WARNING` when it adds a criterion under a decided requirement; that warning names this skill as the step that accounts for the decision.
