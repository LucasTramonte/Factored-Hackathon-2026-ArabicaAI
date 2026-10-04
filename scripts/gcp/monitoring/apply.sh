#!/usr/bin/env bash
# Create or update the uptime check and the alert policies in this folder (scripts/gcp/monitoring/README.md).
# Idempotent: a policy whose displayName already exists is updated in place, never duplicated. Notification channels are
# not set here: attach an existing channel in the console or with --notification-channels; none is invented.
set -euo pipefail
PROJECT="${PROJECT:-factored-hackathon-arabica-ai}"
cd "$(dirname "$0")"
HOST="factored-hackathon-2026-arabicaai.lucas-tramonte.workers.dev"
# The external availability probe the healthz policy reads: /healthz every 5 minutes, expecting the D1 ping's body.
if [ -z "$(gcloud monitoring uptime list-configs --project "$PROJECT" --filter='displayName="arabica-intake-healthz"' --format='value(name)')" ]; then
  gcloud monitoring uptime create arabica-intake-healthz --project "$PROJECT" --resource-type=uptime-url \
    --resource-labels="host=$HOST,project_id=$PROJECT" --protocol=https --path=/healthz --port=443 \
    --matcher-content='"status":"ok"' --matcher-type=contains-string --period=5 --timeout=10 \
    --user-labels=app=arabica-intake,managed_by=repo --format='value(name)'
fi
for file in vertex-suggestions-*.json worker-*.json; do
  name=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["displayName"])' "$file")
  existing=$(gcloud monitoring policies list --project "$PROJECT" --filter="displayName=\"$name\"" --format='value(name)')
  if [ -n "$existing" ]; then
    gcloud monitoring policies update "$existing" --project "$PROJECT" --policy-from-file "$file" --format='value(name)'
  else
    gcloud monitoring policies create --project "$PROJECT" --policy-from-file "$file" --format='value(name)'
  fi
done
