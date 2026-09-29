---
name: yamlet-refresh
description: >-
  Regenerates everything derived from a directory of EARS specs (.yamlet.yaml): the Gherkin
  `.feature` tree (`yamlet tests`) and the Markdown pages people read (`yamlet docs` — specs and
  decision records). REQUIRES the specs source directory as its argument (e.g. `/yamlet-refresh
  specs`); optional second and third arguments are the tests and docs targets, defaulting to
  `<src>/tests` and `<src>/docs` — yamlet-owned directories wiped and rebuilt on every run; an
  optional fourth names a records directory kept outside it. Use as the closing step once a spec
  or a decision record is authored or changed.
argument-hint: <specs-dir> [tests-dir] [docs-dir] [adr-dir]
allowed-tools: Bash(yamlet:*), Read
---

# Yamlet Refresh Skill

Regenerates the two views derived from a directory of specs: the Gherkin `.feature` tree a test runner binds to, and the Markdown pages a teammate or stakeholder reads in a browser. This skill **only projects** — it turns the YAML into those two trees and stops at that boundary. Step definitions, fixtures, the runner and CI belong to whoever consumes them; you **never** touch them, and you never hand-edit a generated page.

## The disconnected boundary — state it, respect it

`yamlet tests` emits `.feature` files plus a `manifest.json`, and nothing else. The steps inside each scenario are the contract the consumer binds real code to. `yamlet docs` emits Markdown pages — an `index.md`, one page per scope, one per decision record in any status — and nothing else; tech specs are never rendered. This skill does not write, edit, or delete any step definition, fixture, runner config or hand-written page — it only regenerates the two trees, and reports what a consumer must then reconcile by hand.

## The binding manifest

Alongside the features, the run writes `TESTS/manifest.json` (`yamlet.tests/v1`): for every scenario, the contract tokens it leaves verbatim — the `inputs`, `outputs`, member `sockets` and declared `reads`/`writes` a consumer's step definitions must bind (example-backed tokens are excluded; they render as `<columns>` and carry their own data). It is the machine-readable list of **binding obligations**, a second view of the same tokens the steps show. A consumer can read it to assert coverage without re-parsing Gherkin. Writing that check, and the step definitions, is theirs; yamlet only emits the obligations.

## Why regenerate every time

Both targets are **yamlet-owned directories**. Every run **wipes and rebuilds** them from the specs, so a renamed or deleted scope can never leave an orphan feature or page behind. The corollary: each target holds nothing but its projection. Step definitions, fixtures, the runner and hand-written docs belong in **their own directories** — anything else left in a target is erased on the next run. `yamlet docs` refuses a non-empty directory it did not write rather than erase it.

The pages are meant to be committed, so they can go stale; `yamlet docs SRC DOCS --check` is the CI gate that fails when they do. Running this skill after every spec change is what keeps that gate green.

Decision records render from under the specs directory. When a repository keeps them beside it instead (a sibling `adr/`), pass that directory as the fourth argument (`/yamlet-refresh specs specs/tests specs/docs adr`) — on every run, or their pages vanish and the specs' links to them turn to plain text.

## Result for `$ARGUMENTS`

!`set -- $ARGUMENTS; SRC="${1:?usage: /yamlet-refresh SRC [TESTS] [DOCS] [ADRS]}"; TESTS="${2:-$SRC/tests}"; yamlet tests "$SRC" "$TESTS" 2>&1`

!`set -- $ARGUMENTS; SRC="${1:?usage: /yamlet-refresh SRC [TESTS] [DOCS] [ADRS]}"; DOCS="${3:-$SRC/docs}"; yamlet docs "$SRC" "$DOCS" ${4:+"--adrs=$4"} 2>&1`

Read the two outputs above and narrate the actionable deltas to the user in plain prose:

- **`wrote N features …`** — the current feature tree, plus a `manifest.json` line. New or changed scenarios are where the consumer's step definitions must be added or updated — call that out, and point to `manifest.json` as the list of tokens each scenario must bind.
- **`wrote N pages …`** — the current docs tree (scopes, decisions, index). Remind the user to commit it with the spec change, so the pages and the YAML move together.
- **`skipped N files …`** — a file was not projected. `no requirements` (tests only) is a legitimate bare composite. `parse error` means the file is invalid — tell the user to run `yamlet verify` (or the `yamlet-verifier` skill) and fix it; it has **no** features and **no** page until it parses.
- **`not empty and was not written by yamlet docs`** — the docs target holds someone's own files, and nothing was erased. Ask the user for a different docs directory and re-invoke with it as the third argument.
- **a usage error** — no source directory was supplied; re-invoke with the specs directory (exit 2).

If a file was skipped for a parse error, you MUST consult with the user rather than assume the regeneration was clean. Remind the user that both targets were rebuilt from scratch: any step definitions or pages they keep there (rather than in their own directories) are gone.

## Exit codes

`0` ok · `2` usage / path / collision error (two specs mapping to the same feature file or page — rename one so their basenames differ within the system), or a docs target that was refused. Nothing partial is left behind on a `2`.
