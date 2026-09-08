---
name: yamlet-adr
description: >-
  Writes a decision record (.adr.yaml) by interviewing the user and driving the `yamlet_adr_*`
  tools, never by hand-writing YAML. Use when a design choice must be recorded — standalone
  (`/skill:yamlet-adr adr`) or inside yamlet-techspec's decision gate.
---

# Yamlet ADR Skill

Turn a choice into a **decision record**: the question, the forces, the dimensions it is judged on, every option judged against all of them, the decision, and what it obliges. You interrogate; you do not decide. The user decides, and the record is frozen once accepted.

## Prerequisite

This skill drives the `yamlet_adr_*` tools from the yamlet pi extension. Without `yamlet_adr_init` and friends, **stop and tell the user** to install it (`pi install git:github.com/RicardoMonteiroSimoes/Yamlet`, and `brew install yamlet` for the CLI). A tool that answers "missing the command(s) … adr" means the CLI on PATH predates decision records — relay its upgrade instruction and stop. Never fall back to `yamlet` through `bash`.

## The hard rules

- **Never write a `.adr.yaml` yourself.** Every byte goes through the `yamlet_adr_*` tools, which mint every id and verify the file on every call. `read` a record to show it. The extension blocks `write`/`edit` on a `*.adr.yaml` and the shell equivalents — being blocked is the rule working.
- **A record is frozen after `accept`.** Nothing changes it afterwards but `reject`, `supersede` and their dates. A decision is revised by writing the next record, never by editing this one.
- **Options before opinions.** No option is written until every dimension is, and no decision until every option is judged against every dimension. The CLI enforces the order; you keep the conversation in it.

## Reading a tool's response

- `yamlet_adr_init` returns the record's path; `add_basis`/`add_dimension`/`add_option`/`add_obligation` return the minted id (`B-1`, `D-3`, `OPT-2`, `R-1`). **Never invent an id** — use the one returned.
- A failure (`error:`) wrote nothing. It names what is missing or out of order; fix the input. A rule the change tripped means the record was not written — tell the user.

## The interview — one thing at a time, in this order

1. **Origin.** What spec criterion or requirement forces the choice (`SPEC.yamlet.yaml#AC-n`), or which prior record it builds on (`ADR-nnnn`)? A record nobody asked for is refused. Then the **kind**: selection (a product), mechanism (a pattern), policy (a fixed value), boundary, sequencing. The **question** must be answerable by choosing one option.
   `yamlet_adr_init({ dir, title, kind, question, arises_from: ["SPEC#AC-n"], assumes: ["ADR-nnnn"] })`
2. **Forces.** Constraints *outside the author's control*: the trust boundary, a spec obligation, a distribution model. A prior record's obligation is **cited** (`ADR-nnnn#R-n`), never restated. `yamlet_adr_add_force({ file, text })`
3. **Basis, if anything will be measured.** The load a number is stated under (a volume, a horizon), each with a numeral and a source. `yamlet_adr_add_basis({ file, quantity, source })`
4. **Dimensions.** The axes, each stated as *the threshold at which it decides anything*, not what the axis is. A measured one names its unit, the yardstick (`source`) and the basis it is stated under. `yamlet_adr_add_dimension({ file, matters, unit, source, basis: ["B-n"] })`
5. **Challenge before the options.** Spawn the **`yamlet-adr-challenger`** agent with the record's path:

   ```
   Agent({
     subagent_type: "yamlet-adr-challenger",
     description: "Challenge ADR before options",
     prompt: "<path/to/record.adr.yaml>"
   })
   ```

   It is headless and cannot ask the user anything, so relay its findings in prose. Resolve every **BLOCKER**, put its **QUESTIONS** to the user. Dimensions are the last thing that is cheap to change.
6. **Options.** At least two; the status quo counts and naming it is what makes the set honest. Each is judged against **every** dimension in one call: a cell states a fact, a measured cell carries a numeral, `n/a — <reason>` is allowed and a bare `n/a` is not. A selection needs a locator per option (`refs`).
   `yamlet_adr_add_option({ file, summary, reversibility: "reversible|costly|one-way", refs: [{ label: "project", locator: "URL" }], against: [{ dimension: "D-1", text: "..." }, ...] })`
7. **Decision.** The user picks. `yamlet_adr_decide({ file, option: "OPT-n" })`
8. **What it obliges, costs, and when it stops being right.** Obligations are work, imperative voice (`yamlet_adr_add_obligation`); costs are taken knowingly and never discharged (`yamlet_adr_add_accept`); a revisit condition with a threshold names its number (`yamlet_adr_add_revisit`).
9. **Accept.** `yamlet_verify({ file })` must report `OK`; then `yamlet_adr_accept({ file })`. Say plainly that the record is now frozen, and that the spec must link it: `yamlet_add_adr({ file: SPEC, adr: FILE, rq: "RQ-n" })` or `ac: "AC-n"` (the tech spec or author does this; if you are standalone, do it and verify the spec).

### If there is no `Agent` tool

The gate needs [`@tintinweb/pi-subagents`](https://pi.dev/packages/@tintinweb/pi-subagents). Without it, do not skip it. Tell the user once that you are running the challenge inline, in your own context, and that it is a weaker check. Then work the real checklist — `yamlet_guide({ topic: "adr-challenge" })` — never your memory of it, and report in the same shape. Be harder on yourself to compensate.

## Superseding

A decision that no longer holds gets a new record: `init` with `assumes` the old id, the same interview, `accept`, then `yamlet_adr_supersede({ file: OLD, by: "ADR-nnnn" })` and a fresh `yamlet_add_adr` where the old one was linked. The old link stays; it is history.
