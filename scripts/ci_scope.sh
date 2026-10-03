#!/usr/bin/env bash
# Decide which quality suites a change needs. Reads changed paths on stdin (one per line) and prints
# `python=…`, `angular=…` and `worker=…` lines for $GITHUB_OUTPUT.
#
# Fails closed: no input, or any path outside the known areas (workflows, Makefile, root config, a new top-level
# folder), runs everything. Folders are matched before the documentation rule, so a Markdown file that code reads
# (the extractor prompt, pre-registration documents, back-end/README.md) still runs the suites that read it.
# Cross-area reads that the rules encode:
#   Python tests read back-end/ (migrations, seeds, identities, routes, README);
#   Worker tests read front-end/ (contracts, the built client), intake_agent/ (the prompt) and evals/ (the scorer).
set -euo pipefail

python=false angular=false worker=false any=false
while IFS= read -r path || [ -n "$path" ]; do
  [ -n "$path" ] || continue
  any=true
  case "$path" in
    front-end/*)                                     angular=true; worker=true ;;
    back-end/*)                                      worker=true; python=true ;;
    intake_agent/*|evals/*)                          python=true; worker=true ;;
    data_pipelines/*|data_foundation/*|data_profiles/*|scripts/*) python=true ;;
    Docs/*|.github/skills/*)                         ;;
    */*)                                             python=true angular=true worker=true ;;
    *.md)                                            ;;
    *)                                               python=true angular=true worker=true ;;
  esac
done
$any || python=true angular=true worker=true

printf 'python=%s\nangular=%s\nworker=%s\n' "$python" "$angular" "$worker"
