---
name: yamlet-adr
description: >-
  Writes a decision record (.adr.yaml) by interviewing the user and driving `yamlet adr`, never by
  hand-writing YAML. Use when a design choice must be recorded — standalone (`/yamlet-adr adr`) or
  inside yamlet-techspec's decision gate.
argument-hint: <records-dir> [what is being decided]
allowed-tools: Bash(yamlet:*), Read, Skill(yamlet-adr-challenger *), Skill(yamlet-skills:yamlet-adr-challenger *), Skill(yamlet-refresh *), Skill(yamlet-skills:yamlet-refresh *)
---

# Yamlet ADR Skill

Turn a choice into a **decision record**: the question, the forces, the dimensions it is judged on, every option judged against all of them, the decision, and what it obliges. You interrogate; you do not decide. The user decides, and the record is frozen once accepted.

## The hard rules

- **Never write a `.adr.yaml` yourself** — no Write, no Edit, no shell redirection. Every byte goes through `yamlet adr`, which mints every id and verifies the file on every call. `Read` a record to show it.
- **A record is frozen after `accept`.** Only `supersede` changes it then. Before that, fix an objection in place (`yamlet adr remove|replace`, see `yamlet help adr`) — never `reject` and restart; `reject --reason` is for an abandoned record.
- **Options before opinions.** No option before the dimensions are challenged, no decision until every option is judged against every dimension.

## Reading the tool's response

- **exit 0** — `init` prints the record's path; `add-basis`/`add-dimension`/`add-option`/`add-obligation` print the minted id (`B-1`, `D-3`, `OPT-2`, `R-1`).
- **exit 2** — `error:` and nothing was written. It names what is missing or out of order; fix the input.
- **exit 3** — the change tripped a rule and was not written. Tell the user.

## The interview — one thing at a time, in this order

1. **Origin.** What spec criterion or requirement forces the choice (`SPEC.yamlet.yaml#AC-n`), or which prior record it builds on (`ADR-nnnn`)? A record nobody asked for is refused. Then the **kind**: selection (a product), mechanism (a pattern), policy (a fixed value), boundary, sequencing. The **question** must be answerable by choosing one option.
   `yamlet adr init DIR --title T --kind K --question Q --arises-from SPEC#AC-n ... [--assumes ADR-nnnn ...]`
2. **Forces.** Constraints *outside the author's control*: the trust boundary, a spec obligation, a distribution model. A prior record's obligation is **cited** (`ADR-nnnn#R-n`), never restated. `yamlet adr add-force FILE TEXT`
3. **Basis, if anything will be measured.** The load a number is stated under (a volume, a horizon), each with a numeral and a source. `yamlet adr add-basis FILE --quantity Q --source S`
4. **Dimensions.** The axes, each stated as *the threshold at which it decides anything*, not what the axis is. A measured one names its unit, the yardstick (`--source`) and the basis it is stated under. `yamlet adr add-dimension FILE --matters M [--unit U --source S --basis B-n]`
5. **Challenge before the options.** Invoke **`yamlet-adr-challenger`** with the record's path (`/yamlet-adr-challenger FILE`). Resolve every **BLOCKER**, put its **QUESTIONS** to the user. Dimensions are cheapest to change now.
6. **Options.** At least two; the status quo counts and naming it is what makes the set honest. Each is judged against **every** dimension in one call: a cell states a fact, a measured cell carries a numeral, `n/a — <reason>` is allowed and a bare `n/a` is not. A selection needs a locator per option (`--ref project=URL`).
   `yamlet adr add-option FILE --summary S --reversibility reversible|costly|one-way [--ref L=URL] --against D-1=... --against D-2=...`
7. **Decision.** The user picks. `yamlet adr decide FILE OPT-n`
8. **What it obliges, costs, and when it stops being right.** Obligations are work, imperative voice (`add-obligation`); costs are taken knowingly and never discharged (`add-accept`); a revisit condition with a threshold names its number (`add-revisit`).
9. **Challenge again.** `/yamlet-adr-challenger FILE --before-accept`; revise for its blockers, put the rest to the user (supersede after accepting; spec changes go to `yamlet-author`).
10. **Accept.** `yamlet verify FILE` must print `OK`; then `yamlet adr accept FILE`. Say plainly that the record is now frozen, and that the spec must link it: `yamlet add-adr SPEC FILE --rq RQ-n | --ac AC-n` (the tech spec or author does this; if you are standalone, do it and verify the spec).
11. **Refresh the derived pages.** A record's status and its links show up in the Markdown docs, so once the last change is made — accepted and linked, rejected, or superseded — invoke **`yamlet-refresh`** with the specs directory (`/yamlet-refresh <specs-dir>`), the same one the author flow refreshes. If the records directory is not inside it, pass the records directory too (the fourth argument; `adrs` on pi), or the record gets no page. Inside yamlet-techspec's decision gate, skip this: the gate links the record and refreshes after.

## Superseding

A decision that no longer holds gets a new record: `init` with `--assumes` the old id, the same interview, `accept`, then `yamlet adr supersede OLD --by NEW` and a fresh `add-adr` where the old one was linked. The old link stays; it is history. Then refresh (step 11).
