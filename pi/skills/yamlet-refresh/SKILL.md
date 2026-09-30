---
name: yamlet-refresh
description: >-
  Regenerates what is derived from a specs directory: the Gherkin `.feature` tree (`yamlet_tests`)
  and the Markdown docs pages (`yamlet_docs`). REQUIRES the specs directory
  (`/skill:yamlet-refresh specs`); optional tests, docs and outside-records directories follow. Use
  as the closing step after a spec or decision record changes.
---

Projection only. Never touch step definitions, fixtures, runners or hand-written docs, and never hand-edit a generated page — fix the YAML and re-run. Both targets are wiped and rebuilt every run.

## Run it

No source directory given: ask and stop — never guess, the targets are wiped. Confirm any target other than the defaults. Run both calls, even if the first fails:

```
yamlet_tests({ src: "<SRC>", target: "<default SRC/tests>" })
yamlet_docs({ src: "<SRC>", target: "<default SRC/docs>", adrs: ["<records dir, only if outside SRC>"] })
```

Never report a projection you did not run. If `yamlet_tests` is not among your tools, the extension is not installed: say so and stop, never shell out. If only `yamlet_docs` fails with an upgrade hint, report the features and tell the user to upgrade.

## Report to the user

- **`wrote N features`** — new or changed scenarios need step definitions; `manifest.json` lists the tokens each must bind.
- **`wrote N pages`** — commit them with the YAML change; `yamlet docs --check` in CI fails otherwise.
- **`skipped … parse error`** — that file has no features and no page until it parses. Point to `yamlet-verifier`, and consult the user before calling the refresh clean.
- **`refusing to erase`** — the docs target holds someone's files; nothing was erased. Ask for another directory.
- **a usage or collision error** — nothing was written; a collision means two specs share a basename within a system.

Say that both targets were rebuilt from scratch: anything else kept in them is gone.
