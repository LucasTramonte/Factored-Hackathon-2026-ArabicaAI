#!/usr/bin/env bash
# Creates or finds the SES sender identity and the Worker's send-only IAM user.
# Idempotent. Never creates an access key: a person does that (Docs/Plans/intake-demo.md).
# Usage: back-end/scripts/ses/setup.sh   (AWS_PROFILE defaults to arabica)
set -euo pipefail

FROM=rzuniga@aptsny.co
USER_NAME=arabicaai-worker-ses
REGION=us-east-2
P=(--profile "${AWS_PROFILE:-arabica}" --output text)
SES=(aws sesv2 "${P[@]}" --region "$REGION")

if ! "${SES[@]}" get-email-identity --email-identity "$FROM" >/dev/null 2>&1; then
  "${SES[@]}" create-email-identity --email-identity "$FROM" >/dev/null
  echo "created identity $FROM; AWS emailed a verification link to it" >&2
fi

account=$(aws sts get-caller-identity "${P[@]}" --query Account)
aws iam get-user "${P[@]}" --user-name "$USER_NAME" >/dev/null 2>&1 \
  || { aws iam create-user "${P[@]}" --user-name "$USER_NAME" >/dev/null; echo "created user $USER_NAME" >&2; }
# put-user-policy overwrites, so rerunning keeps the policy exact.
aws iam put-user-policy "${P[@]}" --user-name "$USER_NAME" --policy-name ses-send-only --policy-document "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [{\"Effect\": \"Allow\", \"Action\": \"ses:SendEmail\",
    \"Resource\": \"arn:aws:ses:$REGION:$account:identity/$FROM\"}]
}"

echo "SES_IDENTITY=$FROM verified=$("${SES[@]}" get-email-identity --email-identity "$FROM" --query VerifiedForSendingStatus)"
echo "SES_USER_ARN=$(aws iam get-user "${P[@]}" --user-name "$USER_NAME" --query User.Arn)"
