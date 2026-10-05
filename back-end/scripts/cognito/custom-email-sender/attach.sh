#!/bin/sh
# Preserve every supported pool-update field. Caller owns provisioning/activation.
set -eu
: "${POOL_ID:?}" "${SENDER_ARN:?}" "${KEY_ARN:?}" "${SNAPSHOT_DIR:?Private ignored directory required}"
umask 077
mkdir -p "$SNAPSHOT_DIR"
[ ! -e "$SNAPSHOT_DIR/before.json" ] || { printf 'Choose a fresh snapshot directory.\n' >&2; exit 1; }
REGION=${REGION:-us-east-2}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
aws cognito-idp describe-user-pool --region "$REGION" --user-pool-id "$POOL_ID" > "$work/before.json"
aws cognito-idp update-user-pool --generate-cli-skeleton input > "$work/shape.json"
jq --slurpfile shape "$work/shape.json" --arg pool "$POOL_ID" --arg sender "$SENDER_ARN" --arg key "$KEY_ARN" '
 .UserPool as $p | reduce ($shape[0] | keys[]) as $k ({}; if $p | has($k) then .[$k]=$p[$k] else . end)
 | .UserPoolId=$pool | .PoolName=$p.Name
 | .LambdaConfig=($p.LambdaConfig // {})
 | if (.LambdaConfig.CustomEmailSender? != null and .LambdaConfig.CustomEmailSender.LambdaArn != $sender) then error("Existing custom sender differs") else . end
 | if (.LambdaConfig.KMSKeyID? != null and .LambdaConfig.KMSKeyID != $key) then error("Existing sender KMS key differs") else . end
 | .LambdaConfig.CustomEmailSender={LambdaVersion:"V1_0",LambdaArn:$sender} | .LambdaConfig.KMSKeyID=$key
 ' "$work/before.json" > "$work/update.json"
aws cognito-idp describe-user-pool --region "$REGION" --user-pool-id "$POOL_ID" > "$work/recheck.json"
jq -S '.UserPool' "$work/before.json" > "$work/a"
jq -S '.UserPool' "$work/recheck.json" > "$work/b"
cmp -s "$work/a" "$work/b" || { printf 'Pool changed; retry from fresh snapshot.\n' >&2; exit 1; }
# Updating creates the Cognito KMS grant under the updating principal's kms:CreateGrant permission.
cp "$work/before.json" "$SNAPSHOT_DIR/before.json"
cp "$work/update.json" "$SNAPSHOT_DIR/update.json"
aws cognito-idp update-user-pool --region "$REGION" --cli-input-json "file://$work/update.json"
aws cognito-idp describe-user-pool --region "$REGION" --user-pool-id "$POOL_ID" > "$SNAPSHOT_DIR/after.json"
jq --slurpfile desired "$work/update.json" '.UserPool as $p | $desired[0] | to_entries | all(.[]; .key == "UserPoolId" or (if .key == "PoolName" then .value == $p.Name else .value == $p[.key] end))' "$SNAPSHOT_DIR/after.json" | jq -e '. == true' >/dev/null || { printf 'Pool readback differs; inspect private snapshots before continuing.\n' >&2; exit 1; }
printf 'Sender attached; existing supported settings preserved.\n'
