# The decision gate

Run this when an unmet criterion cannot be broken into tasks without a choice the user owns, or when a `DECIDED:` record no longer fits the code or the plan. It ends with an ADR on disk and a link in the spec. Until yamlet owns an ADR format, the record is plain markdown; the link is what yamlet checks.

## 1. Put the choice to the user — never decide it

State, in one short block: the criteria that need it (ids and the `shall` lines that force the choice); the options you see, each in one line with its main consequence; and what the code already does, if it leans one way. Recommend one and say why. **Wait for the user.** A choice a person did not make is not a decision, it is an assumption with a file name.

## 2. Write the record

Ask where ADRs live if the repository does not make it obvious (`adr/`, `docs/adr/`, `docs/decisions/` are the usual homes; reuse an existing one). Number it after the highest existing record. Write it with `Write` — this is the one file this skill writes:

```markdown
# ADR-0007: <decision as a short imperative>

**Status:** accepted
**Date:** <today>
**Decides:** `specs/pdf_upload.yamlet.yaml` RQ-5 (AC-8, AC-9)

## Context
<the criteria in one or two sentences, and what forced a choice>

## Decision
<what was chosen, in one paragraph>

## Consequences
<what becomes easier, what becomes harder, what the tasks now assume>
```

Keep it short. `Decides:` names the spec and the ids so the record is findable from either side.

## 3. Link it into the spec

```
yamlet add-adr SPEC adr/ADR-0007-parser.md --rq RQ-5
yamlet add-adr SPEC adr/ADR-0007-parser.md --ac AC-8
```

`--rq` when the decision covers every criterion of the requirement, `--ac` when it is specific to one. The path is relative to the spec's directory and must exist — `add-adr` refuses otherwise. The same record may be linked from several requirements. Verify the spec afterwards (`yamlet verify SPEC`); E109 would mean the path is wrong.

## 4. Superseding

A record that no longer holds is not edited. Write a new one whose `Status` line reads `accepted, supersedes ADR-0003`, set the old one's status to `superseded by ADR-0011`, and link the new record where the old one was linked. The old link stays: it is history, and yamlet does not remove links yet.

## 5. Then continue

Back in `SKILL.md` step 7: the tasks that needed the decision can now be written, and each will print a `DECIDED:` notice naming the record you just linked. That is expected.
