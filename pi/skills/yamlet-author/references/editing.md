# Changing a spec that already exists

The setup procedure for changing an existing spec. Everything from the drafting of a requirement onward is in the skill body — the drill-down, the challenger gate, verify, and the test projection are identical to the creating route. Only the way in differs.

## 1. Find the right file — never guess it

"I want to adapt the e-mail sending spec" does not name a file, and a service routinely has three. Guessing from a filename is exactly the mistake the whole design exists to prevent. Work through these four steps in order:

**a. See which systems exist.**

```
yamlet_systems({ dir: "specs" })
```

Map the user's words onto one `system` slug. If nothing matches, the change may actually be a *new* spec — say so and load `yamlet_guide({ topic: "creating" })` instead.

**b. Ask which behaviour they mean, in their terms.** Before touching anything, ask the user what the spec should *do* differently. Do not ask them to pick a filename — they are thinking about behaviour, not files.

**c. Read the candidates.**

```
yamlet_systems({ dir: "specs", system: "e-mail-sending-service", details: true })
```

`details` prints each scope's summary and description. Two scopes of one service routinely carry near-interchangeable topics ("Send plain e-mail" / "Send e-mail with attachment"); the prose is what separates them. Add `contracts: true` when the inputs and outputs would help decide.

**d. Propose one file, with your reason, and confirm it.** Say which scope you think they mean and why the summary matches what they described. **Get an explicit yes before the first change.**

## 2. Read the blast radius before proposing anything

```
yamlet_impact({ file: "specs/email_service.yamlet.yaml", dir: "specs" })
```

This lists every composite that declares this spec as a member, under which alias, and which of its sockets each one binds, consumes, or names in prose. It always reports how many specs it scanned — if that number looks too small, the search root was too narrow, so pass the directory that actually holds all the specs.

You need this before you propose anything that touches the contract, and it is worth reading even for a behaviour change, because it tells you who is downstream of what you are about to alter.

An `exposes` contract is **total**: every composite must bind every input of every member. So adding an input reaches every file listed, and removing an input or output breaks each consumer that binds or uses it.

## 3. Show the user the current state

`read` the spec and walk the user through what is there now — the requirements, their ids, and their criteria. Anchor the conversation on ids (`RQ-2`, `AC-5`), because that is how every change is addressed.

## 4. Make the change

### Adding a criterion to an existing requirement

Supported, to **any** requirement — not just the most recent one:

```
yamlet_add_criterion({
  file: "specs/email.yamlet.yaml", rq: "RQ-1", pattern: "unwanted",
  if: "the mailbox of {input.recipient} refuses the e-mail",
  shall: ["tell the caller the e-mail was refused"]
})
```

To place it at a specific position rather than at the end of that requirement's criteria, name the sibling it should follow:

```
yamlet_add_criterion({
  file: "specs/email.yamlet.yaml", rq: "RQ-1", after: "AC-1", pattern: "unwanted",
  if: "{input.recipient} has unsubscribed",
  shall: ["skip the send"]
})
```

An inserted criterion gets a letter-suffixed id (`AC-1a`, then `AC-1b`) so it sorts into position and **no existing id changes**. `after` must name a criterion of the requirement in `rq`; if it doesn't, the tool says which requirement it actually belongs to.

### Stored state on an existing criterion

`yamlet_add_state({ file, ac: "AC-2", reads: ["poll.state"] })` merges into its lists (`patterns` guide, "Stored state").

### Adding a new requirement

Unchanged — `yamlet_add_requirement`, then its criteria. Drafted and challenged exactly as in the skill body.

### The header

Every append prints `NOTE: … adds behaviour`. Re-read `summary` and `description` against the change; if they no longer describe the scope, propose new wording to the user and apply it with `yamlet_set_header` (also `topic`).

### Rewording a requirement

A requirement's description is prose no test binds to, so it is the one thing rewritten in place. Agree the new wording with the user first (one capability, one line):

```
yamlet_set_description({
  file: "specs/email.yamlet.yaml", rq: "RQ-2",
  description: "A requested e-mail is never silently lost, and gives up after two days"
})
```

If the rewording changes what the requirement *obliges*, the change is in its criteria, not its description.

### Changing what a criterion obliges

**A changed obligation is a new obligation.** Never look for a way to rewrite a criterion under its id: a step definition bound to `AC-3` would go on passing while asserting the old behaviour. Draft the new criterion exactly as a new one — drill-down and criteria challenger gate from the skill body — then replace the old one in one step. Tell the challenger which id the new criterion replaces, so it judges it against the criteria that stay, not against the one it supersedes:

```
yamlet_replace({
  file: "specs/email.yamlet.yaml", ac: "AC-3",
  reason: "undeliverable after 48 hours now, not 24", pattern: "unwanted",
  if: "the e-mail to {input.recipient} is still undelivered 48 hours after the request",
  shall: ["mark the e-mail to {input.recipient} as undeliverable"]
})
```

It returns the new id (`AC-3a`: the next free letter on the old number, so it sorts into place). `AC-3` stays as a **tombstone** — its id, `removed:` (the reason) and `replaced_by: AC-3a` — so the id is never minted again. Ask the user for the reason in their own words: readers see it for good.

Nothing carries over. Pass the criterion's `reads`/`writes` again if the new obligation still touches them. A criterion-level ADR link is not copied; the `WARNING:` names it — relay it, and link it again with `yamlet_add_adr` only if the user says the decision still decides the new obligation.

### Removing behaviour

Name the ids that will go and get an explicit yes, then:

```
yamlet_rm({ file: "specs/email.yamlet.yaml", ac: "AC-4", reason: "the caller retries itself now" })
yamlet_rm({ file: "specs/email.yamlet.yaml", rq: "RQ-3", reason: "archiving moved to its own scope", replaced_by: "RQ-5" })
```

The block becomes a tombstone, and removing a requirement tombstones its criteria with it. `replaced_by` is optional and names a live block of the same kind. Tombstones are permanent — they are why no id is ever reused; never propose cleaning them up. To move a criterion to another requirement, add it there, then remove the original with `replaced_by` pointing at it.

Refusals, and what to say:

- **The last live criterion of a requirement** — a requirement with no behaviour asserts nothing. Ask whether the requirement itself goes.
- **The last live requirement of a spec** — that is retiring the scope, not editing it. Say so; it is the user's call outside this tool.
- **Rolled back with `E506`/`E511`** — the removed behaviour was the only one to use a contract input or output, and the contract cannot change here. Replace it instead, or note the contract change as follow-up (section 5).

## 5. What this version cannot do yet

Be straight with the user about these. Do not attempt a workaround, and do not try to hand-edit the YAML to get around one — the extension's gate blocks `write`/`edit` on a `*.yamlet.yaml` and blocks the shell equivalents, so the attempt will fail anyway. That gate is the rule working.

| Not yet supported | What to do instead |
|---|---|
| Changing `blast_radius` or `front` | Note it — they change what the spec owes; not settable |
| Adding, removing or renaming a contract input/output | Note it, **and run `yamlet_impact` so the user knows the real cost** — every composite listed would need rewiring |
| Adding a component or connection to a spec that already has requirements | The tool refuses: all wiring must precede the first requirement |

When you hit one of these, say which change is blocked, why, and what you did instead. A clear "this needs a later editing pass, here is exactly what it is" is a good outcome; a silent workaround is not.

## 5a. Decided requirements

`adrs:` on a requirement or criterion links the decisions behind it. Adding a criterion under a linked requirement, or removing, replacing or rewording a linked block, returns a `WARNING:` naming them. Relay it and point to the `yamlet-techspec` skill, which accounts for the decision; never unlink or re-link on your own initiative.

## 6. Then rejoin the shared flow

Once the change is committed, return to the skill body and run its closing steps: read the file back to the user, **verify**, then **project the tests**.

The test projection matters more after an edit than after a creation: it regenerates the whole tree, so a changed scenario's step definitions may now be orphaned or unbound. A removed or replaced criterion has no scenario any more; `manifest.json` lists it under `removed` with its `replaced_by`, so tell the user which step definitions to move (`AC-3` → `AC-3a`) or delete. Bring the refresh report back to the user and say which scenarios changed.
