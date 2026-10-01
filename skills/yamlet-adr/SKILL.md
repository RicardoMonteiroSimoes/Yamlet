---
name: yamlet-adr
description: >-
  Writes a decision record (.adr.yaml) by interviewing the user and driving {{ `yamlet adr` || the `yamlet_adr_*` tools }}, never by
  hand-writing YAML. Use when a design choice must be recorded — standalone (`{{invoke yamlet-adr}} adr`) or
  inside yamlet-techspec's decision gate.
tools: [yamlet, read]
invokes: [yamlet-adr-challenger, yamlet-refresh]
claude:
  argument-hint: <records-dir> [what is being decided]
---

# Yamlet ADR Skill

Turn a choice into a **decision record**: the question, the forces, the dimensions it is judged on, every option judged against all of them, the decision, and what it obliges. You interrogate; you do not decide. The user decides, and the record is frozen once accepted.

{{#pi}}
## Prerequisite

This skill drives the `yamlet_adr_*` tools from the yamlet pi extension. Without `yamlet_adr_init` and friends, **stop and tell the user** to install it (`pi install git:github.com/RicardoMonteiroSimoes/Yamlet`, and `brew install yamlet` for the CLI). A tool that answers "missing the command(s) … adr" means the CLI on PATH predates decision records — relay its upgrade instruction and stop. Never fall back to `yamlet` through `bash`.

{{/pi}}
## The hard rules

{{#claude}}
- **Never write a `.adr.yaml` yourself** — no Write, no Edit, no shell redirection. Every byte goes through `yamlet adr`, which mints every id and verifies the file on every call. `Read` a record to show it.
{{/claude}}
{{#pi}}
- **Never write a `.adr.yaml` yourself.** Every byte goes through the `yamlet_adr_*` tools, which mint every id and verify the file on every call. `read` a record to show it. The extension blocks `write`/`edit` on a `*.adr.yaml` and the shell equivalents — being blocked is the rule working.
{{/pi}}
- **A record is frozen after {{ `accept` || accept }}.** Only {{ `supersede` || `yamlet_adr_supersede` }} changes it then. Before that, fix an objection in place {{ (`yamlet adr remove|replace`, see `yamlet help adr`) || (`yamlet_adr_remove`/`_replace`) }} — never {{ `reject` || reject }} and restart; {{ `reject --reason` || `yamlet_adr_reject` (with a reason) }} is for an abandoned record.
- **Options before opinions.** No option before the dimensions are challenged, no decision until every option is judged against every dimension.

## Reading {{ the || a }} tool's response

{{#claude}}
- **exit 0** — `init` prints the record's path; `add-basis`/`add-dimension`/`add-option`/`add-obligation` print the minted id (`B-1`, `D-3`, `OPT-2`, `R-1`).
- **exit 2** — `error:` and nothing was written. It names what is missing or out of order; fix the input.
- **exit 3** — the change tripped a rule and was not written. Tell the user.
{{/claude}}
{{#pi}}
- `yamlet_adr_init` returns the record's path; `add_basis`/`add_dimension`/`add_option`/`add_obligation` return the minted id (`B-1`, `D-3`, `OPT-2`, `R-1`). **Never invent an id** — use the one returned.
- A failure (`error:`) wrote nothing. It names what is missing or out of order; fix the input. A rule the change tripped means the record was not written — tell the user.
{{/pi}}

## The interview — one thing at a time, in this order

1. **Origin.** What spec criterion or requirement forces the choice (`SPEC.yamlet.yaml#AC-n`), or which prior record it builds on (`ADR-nnnn`)? A record nobody asked for is refused. Then the **kind**: selection (a product), mechanism (a pattern), policy (a fixed value), boundary, sequencing. The **question** must be answerable by choosing one option.
   `{{cmd adr init DIR --title T --kind K --question Q --arises-from SPEC#AC-n ... [--assumes ADR-nnnn ...]}}`
2. **Forces.** Constraints *outside the author's control*: the trust boundary, a spec obligation, a distribution model. A prior record's obligation is **cited** (`ADR-nnnn#R-n`), never restated. `{{cmd adr add-force FILE TEXT}}`
3. **Basis, if anything will be measured.** The load a number is stated under (a volume, a horizon), each with a numeral and a source. `{{cmd adr add-basis FILE --quantity Q --source S}}`
4. **Dimensions.** The axes, each stated as *the threshold at which it decides anything*, not what the axis is. A measured one names its unit, the yardstick (`{{flag --source}}`) and the basis it is stated under. `{{cmd adr add-dimension FILE --matters M [--unit U --source S --basis B-n]}}`
{{#claude}}
5. **Challenge before the options.** Invoke **`yamlet-adr-challenger`** with the record's path (`/yamlet-adr-challenger FILE`). Resolve every **BLOCKER**, put its **QUESTIONS** to the user. Dimensions are cheapest to change now.
{{/claude}}
{{#pi}}
5. **Challenge before the options.** Spawn the **`yamlet-adr-challenger`** agent with the record's path **and the options you plan to write**, one line each, the status quo included. The record holds no options yet and the agent starts from a fresh context, so without that list it cannot judge whether the question is answerable or the set is honest:

   ```
   Agent({
     subagent_type: "yamlet-adr-challenger",
     description: "Challenge ADR before options",
     prompt: "<path/to/record.adr.yaml>\nPlanned options:\n- <option 1>\n- <option 2 (status quo)>"
   })
   ```

   It is headless and cannot ask the user anything, so relay its findings in prose. Resolve every **BLOCKER**, put its **QUESTIONS** to the user. Dimensions are cheapest to change now.
{{/pi}}
6. **Options.** At least two; the status quo counts and naming it is what makes the set honest. Each is judged against **every** dimension in one call: a cell states a fact, a measured cell carries a numeral, `n/a — <reason>` is allowed and a bare `n/a` is not. A selection needs a locator per option ({{ `--ref project=URL` || `refs` }}).
   `{{cmd adr add-option FILE --summary S --reversibility reversible|costly|one-way [--ref L=URL] --against D-1=... --against D-2=...}}`
7. **Decision.** The user picks. `{{cmd adr decide FILE OPT-n}}`
8. **What it obliges, costs, and when it stops being right.** Obligations are work, imperative voice (`{{tool adr add-obligation}}`); costs are taken knowingly and never discharged (`{{tool adr add-accept}}`); a revisit condition with a threshold names its number (`{{tool adr add-revisit}}`).
9. **Challenge again.** {{ `/yamlet-adr-challenger FILE --before-accept` || Spawn it with prompt `Before accept: <record>` plus the paths of the other accepted records beside it and the specs they and it link }}; revise for its blockers, put the rest to the user (supersede after accepting; spec changes go to {{ `yamlet-author` || the yamlet-author skill }}).
10. **Accept.** `{{cmd verify FILE}}` must {{ print || report }} `OK`; then `{{cmd adr accept FILE}}`. Say plainly that the record is now frozen, and that the spec must link it: {{ `yamlet add-adr SPEC FILE --rq RQ-n | --ac AC-n` || `yamlet_add_adr({ file: SPEC, adr: FILE, rq: "RQ-n" })` or `ac: "AC-n"` }} (the tech spec or author does this; if you are standalone, do it and verify the spec).
11. **Refresh.** Standalone, after the last change (accepted and linked, rejected, superseded): {{ `/yamlet-refresh <specs-dir>`, records outside it as the fourth argument || the `yamlet-refresh` skill on the specs directory, records outside it in `adrs` }}. Inside yamlet-techspec's gate, skip — it refreshes after linking.
{{#pi}}

### If there is no `Agent` tool

The gate needs [`@tintinweb/pi-subagents`](https://pi.dev/packages/@tintinweb/pi-subagents). Without it, do not skip it. Tell the user once that you are running the challenge inline, in your own context, and that it is a weaker check. Then work the real checklist — `{{ref adr-challenge}}` — never your memory of it, and report in the same shape. Be harder on yourself to compensate.
{{/pi}}

## Superseding

A decision that no longer holds gets a new record: `init` with `{{flag --assumes}}` the old id, the same interview, `accept`, then `{{cmd adr supersede OLD --by NEW}}` and a fresh `{{tool add-adr}}` where the old one was linked. The old link stays; it is history. Then refresh (step 11).
