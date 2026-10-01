---
# Generated from skills/yamlet-refresh/SKILL.md by scripts/build-skills.ts — edit the source, then rebuild.
name: yamlet-refresh
description: >-
  Regenerates what is derived from a specs directory: the Gherkin `.feature` tree (`yamlet tests`)
  and the Markdown docs pages (`yamlet docs`). REQUIRES the specs directory (`/yamlet-refresh
  specs`); optional tests, docs and outside-records directories follow. Use as the closing step
  after a spec or decision record changes.
argument-hint: <specs-dir> [tests-dir] [docs-dir] [adr-dir]
allowed-tools: Bash(yamlet:*), Read
---

# Yamlet Refresh Skill

Projection only. Never touch step definitions, fixtures, runners or hand-written docs, and never hand-edit a generated page — fix the YAML and re-run. Both targets (default `<src>/tests`, `<src>/docs`) are wiped and rebuilt every run. Records kept outside the specs directory render only when passed as the fourth argument.

## Result for `$ARGUMENTS`

!`set -- $ARGUMENTS; SRC="${1:?usage: /yamlet-refresh SRC [TESTS] [DOCS] [ADRS]}"; TESTS="${2:-$SRC/tests}"; yamlet tests "$SRC" "$TESTS" 2>&1`

!`set -- $ARGUMENTS; SRC="${1:?usage: /yamlet-refresh SRC [TESTS] [DOCS] [ADRS]}"; DOCS="${3:-$SRC/docs}"; yamlet docs "$SRC" "$DOCS" ${4:+"--adrs=$4"} 2>&1`

## Report to the user

- **`wrote N features`** — new or changed scenarios need step definitions; `manifest.json` lists the tokens each must bind.
- **`wrote N pages`** — commit them with the YAML change; `yamlet docs --check` in CI fails otherwise.
- **`skipped … parse error`** — that file has no features and no page until it parses. Point to `yamlet-verifier`, and consult the user before calling the refresh clean.
- **`refusing to erase`** — the docs target holds someone's files; nothing was erased. Ask for another directory.
- **other exit 2** — usage or collision (two specs share a basename within a system); nothing was written.

Say that both targets were rebuilt from scratch: anything else kept in them is gone.
