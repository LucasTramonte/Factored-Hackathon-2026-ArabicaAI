#!/usr/bin/env bash
# Sets the branded sign-in code email (otp-email.html) on the Cognito pool. Idempotent; a person runs it.
# Cognito uses the MFA message template for passwordless EMAIL_OTP codes, and that template can be customized only
# while MFA is OPTIONAL or required (user-pool-email.html, footnote 3). OPTIONAL challenges only users who set an MFA
# preference; ours set none, so sign-in keeps its single code. The pool must already send through SES (EmailSendingAccount
# DEVELOPER): check with `aws cognito-idp describe-user-pool --query UserPool.EmailConfiguration`.
# Usage: back-end/scripts/cognito/otp-email.sh <user-pool-id>   (AWS_PROFILE defaults to arabica, AWS_REGION to us-east-2)
set -euo pipefail
pool_id=${1:?usage: otp-email.sh <user-pool-id>}
here=$(cd "$(dirname "$0")" && pwd)
config=$(python3 - "$here/otp-email.html" <<'PY'
import json, sys
message = open(sys.argv[1], encoding="utf-8").read()
assert "{####}" in message, "the template must contain {####}"
print(json.dumps({"Message": message, "Subject": "Tu código ArabicaAI · Seu código · Your code"}))
PY
)
aws cognito-idp set-user-pool-mfa-config --profile "${AWS_PROFILE:-arabica}" --region "${AWS_REGION:-us-east-2}" \
  --user-pool-id "$pool_id" --mfa-configuration OPTIONAL --email-mfa-configuration "$config" --output json \
  --query '{mfa:MfaConfiguration,subject:EmailMfaConfiguration.Subject}'
echo "Now sign in once and confirm a single branded code email arrives." >&2
