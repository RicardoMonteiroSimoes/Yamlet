---
name: yamlet-tester
description: >-
  Projects a directory of EARS specs (.yamlet.yaml) into a Gherkin `.feature` tree with `yamlet
  tests`, force-regenerating the whole tree every run so it can never drift from the specs.
  REQUIRES one argument — the specs source directory (e.g. `/yamlet-tester specs`); an optional
  second argument is the target directory, defaulting to `<src>/tests`. Use as the closing step
  after a spec is authored/verified, or whenever specs change, to refresh the feature files. It is
  a DISCONNECTED projection: TARGET is yamlet-owned and wiped+rebuilt every run, holding
  `.feature` files only; the skill NEVER creates, edits, or deletes step definitions (which belong
  in the consumer's own directory) — it merely flags where they need attention. If no source
  directory is supplied it returns a usage error and does nothing.
---

# Yamlet Tester Skill

Regenerates the Gherkin `.feature` tree for a directory of specs. This skill **only projects** — it turns acceptance criteria into feature files and stops at that boundary. Step definitions, fixtures, the runner and CI belong to whoever consumes them; you **never** touch them.

## The disconnected boundary — state it, respect it

`yamlet_tests` emits `.feature` files plus a `manifest.json`, and nothing else. The steps inside each scenario are the contract the consumer binds real code to. This skill does not write, edit, or delete any step definition, fixture, or runner config — it only regenerates the `.feature` tree and its manifest, and reports what a consumer must then reconcile by hand.

## The binding manifest

Alongside the features, the run writes `TARGET/manifest.json` (`yamlet.tests/v1`): for every scenario, the contract tokens it leaves verbatim — the `inputs`, `outputs` and member `sockets` a consumer's step definitions must bind (example-backed tokens are excluded; they render as `<columns>` and carry their own data). It is the machine-readable list of **binding obligations**, a second view of the same tokens the steps show. A consumer can read it to assert coverage — every referenced input/output/socket is actually wired — without re-parsing Gherkin. Writing that check, and the step definitions, is theirs; yamlet only emits the obligations.

## Why regenerate every time

`TARGET` is a **yamlet-owned directory**. Every run **wipes it and rebuilds** from the specs, so a renamed or deleted scope can never leave an orphan behind. Because the tree is always a clean function of the specs, there is no drift to detect and no "are the old ones still valid?" question to answer — the answer is enforced, not checked. The corollary: `TARGET` holds nothing but this projection. The consumer's step definitions, fixtures and runner belong in **their own directory**, never in `TARGET` — anything else left there is erased on the next run.

## Run it

Take `src` (and optionally `target`) from the invocation. If no source directory was supplied, ask the user for one and stop — **do not guess a directory, because the target is wiped.** Confirm the target with the user if it is anything other than `<src>/tests`.

```
yamlet_tests({ src: "<SRC>", target: "<TARGET, default SRC/tests>" })
```

Unlike the Claude Code build, pi cannot pre-execute the command and hand you its output — you must actually call the tool before interpreting anything. **Never report a projection you did not run**, and never claim the tree was regenerated if the call failed.

If `yamlet_tests` is not among your tools, the yamlet pi extension is not installed. Say so and stop; do not shell out to `yamlet` instead.

## Read the output

Narrate the actionable deltas to the user in plain prose:

- **`wrote N features …`** — the current feature tree, plus a `manifest.json` line. Each feature line reports its rule/scenario counts. New or changed scenarios are where the consumer's step definitions must be added or updated — call that out, and point to `manifest.json` as the list of tokens each scenario must bind.
- **`skipped N files …`** — a scope was not projected. `no requirements` is a legitimate bare composite (nothing to assert). `parse error` means the file is invalid — tell the user to run the `yamlet-verifier` skill and fix it; that scope has **no** feature coverage until it parses.
- **a usage or collision error** — nothing partial is left behind. A collision means two specs map to the same feature file; rename one so their basenames differ within the system.

If a scope was skipped for a parse error, you MUST consult with the user rather than assume the regeneration was clean. Remind the user that `TARGET` was rebuilt from scratch: any step definitions they keep there (rather than in their own directory) are gone.
