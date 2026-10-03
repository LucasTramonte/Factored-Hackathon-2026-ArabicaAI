# Release

Use this skill after a PR merges, or when asked "is a release due?", to decide whether to cut a version by the rules in [`CONTRIBUTING.md`](../../../CONTRIBUTING.md#versioning) and, if so, to prepare it. It reads Git, GitHub and the deployed state; it never tags, publishes, deploys or runs a remote write without a person's go-ahead ([`AGENTS.md`](../../../AGENTS.md)).

## 1. What is unreleased

```bash
git fetch --tags origin
last=$(git describe --tags --abbrev=0 origin/main)             # e.g. v0.2.0
since=$(git log -1 --format=%cs "$last")
git log "$last"..origin/main --first-parent --format='%h %s'    # one squash commit per PR
gh pr list --state merged --search "merged:>=$since base:main" --json number,title,milestone --limit 100
```

Read each title's Conventional type. PRs without a milestone are a process miss: set the open milestone on them (`gh pr edit <n> --milestone <version>`).

## 2. The next version

- any `feat` → next minor (`v0.X+1.0`); only `fix` / `docs` / `chore` / `eval` / `data` / `refactor` / `test` → next patch (`v0.X.Y+1`);
- `feat!` or `BREAKING CHANGE` → next minor while on 0.x; `v1.0.0` is reserved for the submission.

## 3. Is it due?

Due when all hold: something to release (a user-visible `feat`, or a fix for a live defect); `main` green and deployed with every shipped migration applied to remote D1; no release already today (a live-defect fix may still ship). Overdue when the first unreleased `feat` merged three or more working days ago. If not due, say why and stop.

## 4. Deployed state (read-only)

```bash
cd back-end
npx wrangler deployments list | head -20                                     # live Worker version and its tag
npx wrangler d1 migrations list arabica-intake-demo --remote                 # the deploy applies additive ones; anything left is non-additive
```

Plus the cohort `slice_version` from its manifest and the extractor switch (off or shadow).

## 5. Notes and history

Draft the notes in the structure in `CONTRIBUTING.md` (Highlights, Engineering, Evaluation, Documentation, Known limitations, Deployed state), from what merged, never from plans. Add the version's row and section to [`Docs/releases/README.md`](../../../Docs/releases/README.md) in a `docs(release): vX.Y.Z` PR with the version's milestone.

## 6. With a person's go-ahead

```bash
git tag -a vX.Y.Z <squash sha on main> -m "vX.Y.Z: <milestone name>" && git push origin vX.Y.Z
gh release create vX.Y.Z --verify-tag --title "vX.Y.Z: <milestone name>" --notes-file notes.md
gh api -X PATCH repos/:owner/:repo/milestones/<n> -f state=closed
gh api repos/:owner/:repo/milestones -f title=<next version> -f description="<theme>"
```

A person deploys with `npm --prefix back-end run deploy -- --tag vX.Y.Z --message "vX.Y.Z <short sha>"`.
