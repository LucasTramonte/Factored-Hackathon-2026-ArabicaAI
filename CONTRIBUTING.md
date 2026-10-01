# Contributing and releases

This is how a change gets from a branch to a release. It is meant to keep the history readable and traceable while the team moves fast with AI assistance. It adds no tools: everything below runs on Git, GitHub and the CI we already have. The repository rules for code and data are in [`AGENTS.md`](AGENTS.md), and significant decisions go in an [ADR](Docs/ADRs/README.md).

```
branch → pull request → CI (python, web) → human review → squash merge → main
                                                                   ↓
                              milestone → annotated tag → GitHub Release → release history
```

**PRs are the unit of review. Releases are the unit of product milestones.** Not every PR is a release.

## Branches

Short-lived branches from `main`, named by intent:

| Prefix | For |
|---|---|
| `feat/` | Something a user or agent can do that they couldn't before |
| `fix/` | A defect |
| `docs/` | Documentation only |
| `eval/` | Evaluation sets, runs and their records |
| `data/` | Pipelines, findings and seeds |
| `chore/` | Tooling, CI and repository hygiene |

Branches named after the tool that started them (`claude/…`, `codex/…`) are fine. The PR title is what has to describe the product change.

## Commits and PR titles

We use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) with these types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore`, `revert`.

Add a scope when it helps, for example `feat(intake): …`, `fix(front-end): …`, `docs(adr): …` or `test(data): …`. There is no fixed list of scopes.

- **The PR title must be a Conventional Commit.** With squash merge, it becomes the one commit on `main`, so it has to say what changed in product terms. For example: `fix(intake): a retried confirm never creates a second case`.
- **Commits inside a PR** should follow the convention too, but review fixups ("Address CodeRabbit…") are fine. The squash removes them from `main`, and the PR keeps them.
- **Each commit message states the tests that were run** ([`AGENTS.md`](AGENTS.md)).
- **Never rewrite shared history.** Don't force-push `main` or a branch someone else has reviewed, and don't amend after review. Fix forward with a new commit.

## Pull requests

- **Keep a PR small and about one thing.** A PR that mixes a refactor, a feature and a data change is hard to review and hard to revert.
- **Fill in the [PR template](.github/pull_request_template.md):**
  - what changed and why;
  - the evidence (ADR, finding, evaluation, or judge-feedback ID from [`JUDGE_FEEDBACK.md`](Docs/deliverables/JUDGE_FEEDBACK.md));
  - how it was validated;
  - the risk and the rollback;
  - any D1 or data impact.
- **Any API change comes with the adversarial tests** listed in [`AGENTS.md`](AGENTS.md).
- **Before merging:** CI is green, one human has approved, and every review conversation is resolved.
- **Squash merge by default.** Use a merge commit only for a deliberate integration PR whose commits must stay separate on `main`, and say so in the PR.

### Work done with AI assistance

Most of our code and documents are drafted with an AI assistant. Here is how that stays reviewable:
- **The person who opens the PR owns it.** They have run the tests and read the whole diff.
- **A second person reviews it.** An author never approves their own PR.
- **The `Co-Authored-By` trailer records the assistant.** The history stays about the product and the evidence, not about the tool.
- **The assistant follows [`AGENTS.md`](AGENTS.md).** That includes never touching unrelated working-tree changes and never publishing, tagging or running `--remote` commands without a person's go-ahead.

## Versioning

We use [Semantic Versioning](https://semver.org/), with each version tied to a product milestone:

- **`v0.MINOR.0`** is a milestone a judge or user could test: a new capability, a new data cut, or an evaluation result that changes what the service does.
- **`v0.MINOR.PATCH`** is a fix to a released milestone.
- **`v1.0.0`** is the final hackathon submission.

Version numbers are never assigned retroactively to old commits. The first tag is an intentional baseline.

## Releasing

A release is cut from `main`, on a green squash commit, by a person.

1. **Confirm CI is green on the commit.** Read the deployed state:
   - the Worker version from `npx wrangler deployments list`, in `back-end/`;
   - the D1 migration level from `npx wrangler d1 migrations list arabica-intake-demo --remote`;
   - the cohort `slice_version` from its manifest and `seed_loads`;
   - the extractor switch (off, or shadow).
2. **When deploying, label the Worker version with the release:** `npm --prefix back-end run deploy -- --tag v0.X.Y --message "v0.X.Y <short sha>"`. Without a label, `wrangler deployments list` can't say which commit is live.
3. **Tag the commit:** `git tag -a v0.X.Y <sha> -m "v0.X.Y: <milestone name>"`, then `git push origin v0.X.Y`.
4. **Publish the release:** `gh release create v0.X.Y --verify-tag --title "v0.X.Y: <milestone name>" --notes-file <notes.md>`.
5. **Add a row to the [release history](Docs/releases/README.md)** in a small `docs(release): …` PR.

**Release notes structure:**

```
## Highlights        What a user or judge can now do, in two to four lines.
## Engineering       Notable changes to the runtime, data or pipeline, with PR numbers.
## Evaluation        Results that changed, with links to the run or record.
## Documentation     New or changed deliverables and ADRs.
## Known limitations What doesn't work yet or isn't claimed. Never left empty.
## Deployed state    Worker version, D1 migration level, cohort slice_version, extractor state.
```

Write what was merged, not what was hoped for. `gh pr list --state merged --search "merged:>=<last release date>"` lists the PRs to cover.

## Tools we considered and don't use

| Tool | What it solves | Why not now |
|---|---|---|
| Release Please, semantic-release | Versions and changelogs generated from commit types | Only about a quarter of our recent commits are Conventional, and only a handful of releases are left before submission. Writing the notes by hand costs minutes and stays accurate |
| commitlint, commit hooks | Enforcing the commit format | Adds friction to every AI-assisted commit. A Conventional PR title plus squash merge gives the same `main` history |
| CHANGELOG.md | A committed change list | It would repeat the GitHub Releases. The [release history](Docs/releases/README.md) adds what Releases can't: the ADRs, evidence and deployed state per version |
| CODEOWNERS | Routing reviews by path | Four people review everything; routing adds nothing |
| Merge queue | Serializing merges under heavy concurrency | Few PRs merge at once |
| Signed commits | Proving who authored a commit | Key management for every machine and agent; review plus protected `main` already gates what lands |
| Required linear history | No merge commits on `main` | Squash-only merging already gives it |
