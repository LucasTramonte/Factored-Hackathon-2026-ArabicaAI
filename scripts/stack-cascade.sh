#!/usr/bin/env bash
# stack-cascade.sh MERGED_SHA [MERGED_PR_NUMBER] [MERGED_BRANCH]
#
# Keep stacked PRs mergeable after a squash merge into main, without rebasing.
# For every open same-repository PR whose head contains MERGED_SHA (the merged
# PR's head), in stack order: a PR based on main or MERGED_BRANCH is retargeted
# to main and merges origin/main (any other base is skipped); each
# PR above it merges its (just updated) base branch. A conflict while merging
# main is resolved only when, for every conflicted file, main's version is
# byte-identical to MERGED_SHA's version (the PR already holds that content and
# more), by keeping the PR's side. Any other conflict aborts, comments on the
# PR, and stops that PR and every PR stacked on it. Pushes are fast-forward
# only (never --force); a rejected push also comments and stops. Each push
# dispatches quality.yml for the branch.
#
# Run from a clone with full history and `origin` fetched; needs gh and jq.
set -euo pipefail

: "${1:?usage: stack-cascade.sh MERGED_SHA [PR_NUMBER] [MERGED_BRANCH]}"
pr_ref=${2:+ after #$2}
merged_branch=${3:-}
git fetch -q origin
# Unknown after a full fetch: its branch was deleted and no branch contains it.
merged=$(git rev-parse -q --verify "$1^{commit}") || { echo "nothing to cascade${pr_ref}"; exit 0; }

# "number head base" lines for open PRs whose head contains the merged commit.
prs=$(gh pr list --state open --limit 200 --json number,headRefName,baseRefName,isCrossRepository |
  jq -r '.[] | select(.isCrossRepository | not) |"\(.number) \(.headRefName) \(.baseRefName)"')
pending=$(echo "$prs" | while read -r n head base; do
  if [ -n "$n" ] && git merge-base --is-ancestor "$merged" "origin/$head" 2>/dev/null; then echo "$n $head $base"; fi
done)
[ -n "$pending" ] || { echo "nothing to cascade${pr_ref}"; exit 0; }
heads=" $(echo "$pending" | awk '{print $2}' | tr '\n' ' ') "
blocked=" "

stop() { # stop N HEAD MESSAGE: comment, block HEAD and the stack above it
  gh pr comment "$1" --body "Stack cascade${pr_ref}: $3 A person must merge \`main\` (or the base branch) into \`$2\` by hand."
  blocked="$blocked$2 "
  echo "#$1 $2: stopped ($3)"
}

# ponytail: O(n^2) ancestry ordering; stacks are a handful of PRs.
while [ -n "$pending" ]; do
  remaining_heads=" $(echo "$pending" | awk '{print $2}' | tr '\n' ' ') "
  next=$(echo "$pending" | while read -r n head base; do
    if [[ "$remaining_heads" != *" $base "* ]]; then echo "$n $head $base"; break; fi
  done)
  [ -n "$next" ] || { echo "cycle in PR bases: $pending" >&2; exit 1; }
  pending=$(echo "$pending" | grep -vxF "$next" || true)
  read -r n head base <<<"$next"

  if [[ "$blocked" == *" $base "* ]]; then
    blocked="$blocked$head "; echo "#$n $head: skipped (base $base stopped)"; continue
  fi

  git checkout -q --detach "origin/$head"
  if [[ "$heads" == *" $base "* ]]; then
    source_ref="origin/$base"
  elif [ "$base" = main ] || [ "$base" = "$merged_branch" ]; then
    [ "$base" = main ] || gh pr edit "$n" --base main >/dev/null
    source_ref=origin/main
  else
    echo "#$n $head: skipped (base $base is not main or part of this stack)"; continue
  fi

  before=$(git rev-parse HEAD)
  if ! git merge -q --no-ff --no-edit -m "Merge ${source_ref#origin/} into $head${pr_ref} (stack cascade)" "$source_ref" >/dev/null 2>&1; then
    conflicted=$(git diff --name-only --diff-filter=U)
    differing=""
    [ -n "$conflicted" ] || differing=" (merge failed without file conflicts)"
    if [ "$source_ref" = origin/main ]; then
      while IFS= read -r f; do # missing on both sides -> both empty -> identical
        [ "$(git rev-parse -q --verify "origin/main:$f" || true)" = "$(git rev-parse -q --verify "$merged:$f" || true)" ] ||
          differing="$differing $f"
      done <<<"$conflicted"
    else
      differing=" $(echo $conflicted)"
    fi
    if [ -n "$differing" ]; then
      git merge --abort
      stop "$n" "$head" "merging \`${source_ref#origin/}\` conflicts in:$differing."
      continue
    fi
    while IFS= read -r f; do
      if git cat-file -e "HEAD:$f" 2>/dev/null; then git checkout -q --ours -- "$f" && git add -- "$f"
      else git rm -q -- "$f"; fi
    done <<<"$conflicted"
    git commit -q --no-edit
    action="merged ${source_ref#origin/}, kept PR side in:$(echo " "$conflicted)"
  else
    action="merged ${source_ref#origin/}"
  fi

  if [ "$(git rev-parse HEAD)" = "$before" ]; then
    echo "#$n $head: up to date"; continue
  fi
  git push -q origin "HEAD:refs/heads/$head" || {
    stop "$n" "$head" "push rejected (a workflow file change or branch protection)."; continue; }
  git fetch -q origin
  gh workflow run quality.yml --ref "$head"
  echo "#$n $head: $action, pushed, CI dispatched"
done
