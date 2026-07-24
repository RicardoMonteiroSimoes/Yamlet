---
name: yamlet-tester
description: Projects a directory of EARS specs (.yamlet.yaml) into a Gherkin `.feature` tree with `yamlet tests`, force-regenerating the whole tree every run so it can never drift from the specs. REQUIRES one argument — the specs source directory (e.g. `/yamlet-tester specs`); an optional second argument is the target directory, defaulting to `<src>/tests`. Use as the closing step after a spec is authored/verified, or whenever specs change, to refresh the feature files. It is a DISCONNECTED projection: TARGET is yamlet-owned and wiped+rebuilt every run, holding `.feature` files only; the skill NEVER creates, edits, or deletes step definitions (which belong in the consumer's own directory) — it merely flags where they need attention. If no source directory is supplied it returns a usage error and does nothing.
allowed-tools: Bash(yamlet:*), Read
---

# Yamlet Tester Skill

Regenerates the Gherkin `.feature` tree for a directory of specs. This skill **only projects** — it turns acceptance criteria into feature files and stops at that boundary. Step definitions, fixtures, the runner and CI belong to whoever consumes them; you **never** touch them.

## The disconnected boundary — state it, respect it

`yamlet tests` emits `.feature` files plus a `manifest.json`, and nothing else. The steps inside each scenario are the contract the consumer binds real code to. This skill does not write, edit, or delete any step definition, fixture, or runner config — it only regenerates the `.feature` tree and its manifest, and reports what a consumer must then reconcile by hand.

## The binding manifest

Alongside the features, the run writes `TARGET/manifest.json` (`yamlet.tests/v1`): for every scenario, the contract tokens it leaves verbatim — the `inputs`, `outputs` and member `sockets` a consumer's step definitions must bind (example-backed tokens are excluded; they render as `<columns>` and carry their own data). It is the machine-readable list of **binding obligations**, a second view of the same tokens the steps show. A consumer can read it to assert coverage — every referenced input/output/socket is actually wired — without re-parsing Gherkin. Writing that check, and the step definitions, is theirs; yamlet only emits the obligations.

## Why regenerate every time

`TARGET` is a **yamlet-owned directory**. Every run **wipes it and rebuilds** from the specs, so a renamed or deleted scope can never leave an orphan behind. Because the tree is always a clean function of the specs, there is no drift to detect and no "are the old ones still valid?" question to answer — the answer is enforced, not checked. The corollary: `TARGET` holds nothing but this projection. The consumer's step definitions, fixtures and runner belong in **their own directory**, never in `TARGET` — anything else left there is erased on the next run.

## Result for `$ARGUMENTS`

!`set -- $ARGUMENTS; SRC="${1:?usage: /yamlet-tester SRC [TARGET]}"; TARGET="${2:-$SRC/tests}"; yamlet tests "$SRC" "$TARGET" 2>&1`

Read the output above and narrate the actionable deltas to the user in plain prose:

- **`wrote N features …`** — the current feature tree, plus a `manifest.json` line. Each feature line reports its rule/scenario counts. New or changed scenarios are where the consumer's step definitions must be added or updated — call that out, and point to `manifest.json` as the list of tokens each scenario must bind.
- **`skipped N files …`** — a scope was not projected. `no requirements` is a legitimate bare composite (nothing to assert). `parse error` means the file is invalid — tell the user to run `yamlet verify` (or the `yamlet-verifier` skill) and fix it; that scope has **no** feature coverage until it parses.
- **a usage error** — no source directory was supplied; re-invoke with the specs directory (exit 2).

If a scope was skipped for a parse error, you MUST consult with the user rather than assume the regeneration was clean. Remind the user that `TARGET` was rebuilt from scratch: any step definitions they keep there (rather than in their own directory) are gone.

## Exit codes

`0` ok · `2` usage / path / collision error (two specs mapping to the same feature file — rename one so their basenames differ within the system). Nothing partial is left behind on a `2`.
