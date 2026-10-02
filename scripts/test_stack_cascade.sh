#!/usr/bin/env bash
# test_stack_cascade.sh: offline check of stack-cascade.sh against a throwaway
# repo (bare origin, stack A <- B <- C, A squash-merged) and a fake `gh` that
# records calls. Case 1: the cascade merges forward and B's content wins.
# Case 2: main also changed x on its own, so B is stopped and C is untouched.
# Case 3: origin rejects the push, so B is stopped with a comment and C skipped.
# Case 4: the top PR C is merged and its branch deleted; a fresh clone (as in
# CI) lacks its head and nothing is stacked on it, so the script exits 0.
# PRs from a fork, or based on a branch other than main/the merged one, are left alone.
set -euo pipefail

script="$(cd "$(dirname "$0")" && pwd)/stack-cascade.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1

mkdir "$tmp/bin"
cat >"$tmp/bin/gh" <<'EOF'
#!/usr/bin/env bash
echo "$*" >>"$GH_LOG"
if [ "$1 $2" = "pr list" ]; then
  # 9: unrelated; 10: contains A but its base "gone" is not the merged branch; 11: from a fork.
  echo '[{"number":2,"headRefName":"B","baseRefName":"A","isCrossRepository":false},
    {"number":3,"headRefName":"C","baseRefName":"B","isCrossRepository":false},
    {"number":9,"headRefName":"other","baseRefName":"main","isCrossRepository":false},
    {"number":10,"headRefName":"orphan","baseRefName":"gone","isCrossRepository":false},
    {"number":11,"headRefName":"fork","baseRefName":"A","isCrossRepository":true}]'
fi
EOF
chmod +x "$tmp/bin/gh"
export PATH="$tmp/bin:$PATH"

fail() { echo "FAIL: $*" >&2; exit 1; }

# setup CASE_DIR [extra-main-edit]: build origin + stack, squash-merge A, print A's head.
setup() {
  local d=$1
  git init -q --bare -b main "$d/origin.git"
  git -C "$d/origin.git" config receive.denyNonFastForwards true # a force push would be rejected
  git clone -q "$d/origin.git" "$d/dev" 2>/dev/null
  cd "$d/dev"
  echo base >x && git add x && git commit -qm base && git push -q origin HEAD:main
  git checkout -qb A && echo a1 >x && git commit -qam A && git push -q origin A
  git checkout -qb B && echo a2 >x && echo y >y && git add y && git commit -qam B && git push -q origin B
  git checkout -qb C && echo z >z && git add z && git commit -qm C && git push -q origin C
  git checkout -qb other main && echo o >o && git add o && git commit -qm other && git push -q origin other
  git push -q origin A:refs/heads/orphan A:refs/heads/fork
  # Squash merge of A: one commit on main with A's tree, then GitHub deletes A.
  git push -q origin "$(git commit-tree "A^{tree}" -p main -m 'A (#1)'):refs/heads/main"
  git push -q origin --delete A
  if [ -n "${2:-}" ]; then
    git fetch -q origin && git checkout -q --detach origin/main
    echo unrelated >x && git commit -qam unrelated && git push -q origin HEAD:main
  fi
  git rev-parse A
}

echo "case 1: squash-merged A, stack B <- C cascades"
mkdir "$tmp/c1"; export GH_LOG="$tmp/c1/gh.log"; : >"$GH_LOG"
a=$(setup "$tmp/c1")
cd "$tmp/c1/dev" && "$script" "$a" 1 A
git fetch -q origin
[ "$(git rev-parse origin/orphan)" = "$a" ] && [ "$(git rev-parse origin/fork)" = "$a" ] ||
  fail "a PR outside the merged branch's stack was pushed"
git merge-tree --write-tree origin/main origin/B >/dev/null || fail "B does not merge cleanly into main"
git merge-tree --write-tree origin/main origin/C >/dev/null || fail "C does not merge cleanly into main"
[ "$(git show origin/B:x)" = a2 ] || fail "B's x was not kept"
[ "$(git show origin/C:x)" = a2 ] && [ "$(git show origin/C:z)" = z ] || fail "C lost content"
git log -1 --format=%s origin/B | grep -qx 'Merge main into B after #1 (stack cascade)' || fail "B merge message"
grep -qx 'pr edit 2 --base main' "$GH_LOG" || fail "B not retargeted to main"
grep -qx 'workflow run quality.yml --ref B' "$GH_LOG" || fail "CI not dispatched for B"
grep -qx 'workflow run quality.yml --ref C' "$GH_LOG" || fail "CI not dispatched for C"
! grep -q 'comment\|edit 1[01]\|orphan\|fork' "$GH_LOG" || fail "unexpected gh call"

echo "case 2: main changed x independently, B is stopped and C untouched"
mkdir "$tmp/c2"; export GH_LOG="$tmp/c2/gh.log"; : >"$GH_LOG"
a=$(setup "$tmp/c2" extra)
cd "$tmp/c2/dev" && c_before=$(git rev-parse origin/C) b_before=$(git rev-parse origin/B)
"$script" "$a" 1 A
git fetch -q origin
[ "$(git rev-parse origin/B)" = "$b_before" ] || fail "B was pushed"
[ "$(git rev-parse origin/C)" = "$c_before" ] || fail "C was pushed"
grep -q '^pr comment 2 --body .*conflicts in: x\..*by hand' "$GH_LOG" || fail "no comment on B"
! grep -q 'workflow run\|comment 3' "$GH_LOG" || fail "unexpected gh call"
git status --porcelain | grep -q . && fail "merge left in progress"

echo "case 3: origin rejects the push to B, B is stopped and C skipped"
mkdir "$tmp/c3"; export GH_LOG="$tmp/c3/gh.log"; : >"$GH_LOG"
a=$(setup "$tmp/c3")
printf '#!/bin/sh\nexit 1\n' >"$tmp/c3/origin.git/hooks/pre-receive" && chmod +x "$tmp/c3/origin.git/hooks/pre-receive"
cd "$tmp/c3/dev" && c_before=$(git rev-parse origin/C)
"$script" "$a" 1 A 2>/dev/null
git fetch -q origin
[ "$(git rev-parse origin/C)" = "$c_before" ] || fail "C was pushed"
grep -q '^pr comment 2 --body .*push rejected' "$GH_LOG" || fail "no comment on B"
! grep -q 'workflow run\|comment 3' "$GH_LOG" || fail "unexpected gh call"

echo "case 4: top PR C merged and deleted, nothing stacked on it"
mkdir "$tmp/c4"; export GH_LOG="$tmp/c4/gh.log"; : >"$GH_LOG"
setup "$tmp/c4" >/dev/null
cd "$tmp/c4/dev" && c=$(git rev-parse C)
git push -q origin "$(git commit-tree "C^{tree}" -p origin/main -m 'C (#3)'):refs/heads/main"
git push -q origin --delete C
git clone -q --no-local "$tmp/c4/origin.git" "$tmp/c4/ci" 2>/dev/null
cd "$tmp/c4/ci" && out=$("$script" "$c" 3 C) || fail "exit $? on a merged top PR"
echo "$out" | grep -q 'nothing to cascade' || fail "no 'nothing to cascade' message: $out"
! grep -q 'edit\|comment\|workflow run' "$GH_LOG" || fail "unexpected gh call"

echo "PASS"
