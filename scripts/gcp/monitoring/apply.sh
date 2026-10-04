#!/usr/bin/env bash
# Create or update the Vertex AI suggestion alert policies from this folder (scripts/gcp/monitoring/README.md).
# Idempotent: a policy whose displayName already exists is updated in place, never duplicated. Notification channels are
# not set here: attach an existing channel in the console or with --notification-channels; none is invented.
set -euo pipefail
PROJECT="${PROJECT:-factored-hackathon-arabica-ai}"
cd "$(dirname "$0")"
for file in vertex-suggestions-*.json; do
  name=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["displayName"])' "$file")
  existing=$(gcloud monitoring policies list --project "$PROJECT" --filter="displayName=\"$name\"" --format='value(name)')
  if [ -n "$existing" ]; then
    gcloud monitoring policies update "$existing" --project "$PROJECT" --policy-from-file "$file" --format='value(name)'
  else
    gcloud monitoring policies create --project "$PROJECT" --policy-from-file "$file" --format='value(name)'
  fi
done
