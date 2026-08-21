# Changing a spec that already exists

The setup procedure for changing an existing spec. Everything from the drafting of a requirement onward is in `SKILL.md` — the drill-down, the challenger gate, verify, and the test projection are identical to the creating route. Only the way in differs.

## 1. Find the right file — never guess it

"I want to adapt the e-mail sending spec" does not name a file, and a service routinely has three. Guessing from a filename is exactly the mistake the whole design exists to prevent. Work through these four steps in order:

**a. See which systems exist.**

```
yamlet systems specs
```

Map the user's words onto one `system:` slug. If nothing matches, the change may actually be a *new* spec — say so and re-route.

**b. Ask which behaviour they mean, in their terms.** Before touching anything, ask the user what the spec should *do* differently. Do not ask them to pick a filename — they are thinking about behaviour, not files.

**c. Read the candidates.**

```
yamlet systems specs --system=e-mail-sending-service --details
```

`--details` prints each scope's summary and description. Two scopes of one service routinely carry near-interchangeable topics ("Send plain e-mail" / "Send e-mail with attachment"); the prose is what separates them. Add `--contracts` when the inputs and outputs would help decide.

**d. Propose one file, with your reason, and confirm it.** Say which scope you think they mean and why the summary matches what they described. **Get an explicit yes before the first change.**

## 2. Read the blast radius before proposing anything

```
yamlet impact specs/email_service.yamlet.yaml specs
```

This lists every composite that declares this spec as a member, under which alias, and which of its sockets each one binds, consumes, or names in prose. It always reports how many specs it scanned — if that number looks too small, the search root was too narrow, so pass the directory that actually holds all the specs.

You need this before you propose anything that touches the contract, and it is worth reading even for a behaviour change, because it tells you who is downstream of what you are about to alter.

An `exposes` contract is **total**: every composite must bind every input of every member. So adding an input reaches every file listed, and removing an input or output breaks each consumer that binds or uses it.

## 3. Show the user the current state

`Read` the spec and walk the user through what is there now — the requirements, their ids, and their criteria. Anchor the conversation on ids (`RQ-2`, `AC-5`), because that is how every change is addressed.

## 4. Make the change

### Adding a criterion to an existing requirement

Supported, to **any** requirement — not just the most recent one:

```
yamlet add-criterion specs/email.yamlet.yaml --rq RQ-1 --pattern unwanted \
  --if "the SMTP server rejects the recipient" \
  --shall "surface the rejection reason to the caller"
```

To place it at a specific position rather than at the end of that requirement's criteria, name the sibling it should follow:

```
yamlet add-criterion specs/email.yamlet.yaml --rq RQ-1 --after AC-1 --pattern event \
  --when "a send is retried" --shall "log the retry attempt"
```

An inserted criterion gets a letter-suffixed id (`AC-1a`, then `AC-1b`) so it sorts into position and **no existing id changes**. `--after` must name a criterion of the requirement in `--rq`; if it doesn't, the tool says which requirement it actually belongs to.

### Adding a new requirement

Unchanged — `yamlet add-requirement`, then its criteria. Drafted and challenged exactly as in `SKILL.md`.

### Changing behaviour something already depends on

**Do not look for a way to rewrite in place. Add the replacement alongside the original, then remove the original once the new path is live.** Two requirements may describe the same capability, and the verifier will not object — a temporary duplicate is a correct intermediate state, not a mistake.

1. `add-requirement` the new wording, and `add-criterion` its criteria. New ids throughout; the old ones keep passing.
2. Re-project the tests. Both old and new scenarios exist, so the consumer can write step definitions for the new ones while the old stay green.
3. Remove the original once the new path is live.

The tree is valid at every step and nothing breaks in between. Tell the user this is what you are doing and why — the instinct is to rewrite, and a rewrite leaves a green test suite quietly asserting something else.

**Removal is not implemented yet** (see below), so today you carry out steps 1 and 2 and record step 3 for the user as follow-up work. Say that plainly rather than pretending the migration is complete.

## 5. What this version cannot do yet

Be straight with the user about these. Do not attempt a workaround, and never hand-edit the YAML to get around one — `yamlet` will refuse anyway, and the file's correctness guarantee comes from the tool owning every byte.

| Not yet supported | What to do instead |
|---|---|
| Revising a requirement's or criterion's text | Add the replacement alongside it (step 4 above) and note the removal as follow-up |
| Removing a requirement or criterion | Note it for the user as follow-up work |
| Changing header fields (`topic`, `summary`, `description`, `blast_radius`, `front`) | Note it; nothing in the tool can change them today |
| Adding, removing or renaming a contract input/output | Note it, **and run `yamlet impact` so the user knows the real cost** — every composite listed would need rewiring |
| Adding a component or connection to a spec that already has requirements | The tool refuses: all wiring must precede the first requirement |

When you hit one of these, say which change is blocked, why, and what you did instead. A clear "this needs a later editing pass, here is exactly what it is" is a good outcome; a silent workaround is not.

## 6. Then rejoin the shared flow

Once the change is committed, return to `SKILL.md` and run its closing steps: read the file back to the user, **verify**, then **project the tests**.

The test projection matters more after an edit than after a creation: it regenerates the whole tree, so a changed scenario's step definitions may now be orphaned or unbound. Bring the tester's report back to the user and say which scenarios changed.
