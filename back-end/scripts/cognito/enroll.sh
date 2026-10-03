#!/usr/bin/env bash
# Enrols one email in the arabicaai-demo pool: creates the user (no invitation email, email
# verified, custom:customer_id set) and adds it to a group. Rerunning compares the immutable
# custom:customer_id and refuses if it differs; it adds the user to the given group and does not
# remove earlier groups.
# Usage: enroll.sh <email> <customer_id> [group]     group defaults to customer
#        enroll.sh <email> - agent                    no customer id (agents, auditors)
# Admins: `enroll.sh <email> <customer_id> admin` (an admin also needs a customer id to use the customer view).
set -euo pipefail

email=${1:?email}; customer_id=${2:?customer_id or -}; group=${3:-customer}
REGION=${AWS_REGION:-us-east-2}
AWS=(aws cognito-idp --profile "${AWS_PROFILE:-arabica}" --region "$REGION" --output text)
pool_id=$("${AWS[@]}" list-user-pools --max-results 60 --query "UserPools[?Name=='arabicaai-demo'].Id | [0]")
[ -n "$pool_id" ] && [ "$pool_id" != "None" ] || { echo "pool not found; run setup.sh" >&2; exit 1; }

attrs=(Name=email,Value="$email" Name=email_verified,Value=true)
[ "$customer_id" != "-" ] && attrs+=(Name=custom:customer_id,Value="$customer_id")

if current=$("${AWS[@]}" admin-get-user --user-pool-id "$pool_id" --username "$email" \
     --query "UserAttributes[?Name=='custom:customer_id'].Value | [0]" 2>/dev/null); then
  # custom:customer_id is immutable (Cognito rejects even re-setting the same value), so only check it.
  [ "$current" = "None" ] && current="-"
  [ "$current" = "$customer_id" ] || { echo "$email already has customer_id '$current'; delete the user to change it" >&2; exit 1; }
  echo "exists $email" >&2
else
  "${AWS[@]}" admin-create-user --user-pool-id "$pool_id" --username "$email" \
    --user-attributes "${attrs[@]}" --message-action SUPPRESS >/dev/null
  echo "created $email" >&2
fi
"${AWS[@]}" admin-add-user-to-group --user-pool-id "$pool_id" --username "$email" --group-name "$group"
echo "$email in group $group" >&2
