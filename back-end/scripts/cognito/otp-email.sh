#!/usr/bin/env bash
# Sets the branded sign-in code email (otp-email.html) on the Cognito pool. Idempotent; a person runs it, after the
# deploy that ships the hosted logo.
#
# Why MFA: Cognito uses the MFA message template for passwordless EMAIL_OTP codes, and that template can be customized
# only while MFA is OPTIONAL or required (user-pool-email.html, footnote 3). OPTIONAL challenges only users who set an MFA
# preference, so the script first checks that none has, and that no SMS or TOTP MFA is configured:
# set-user-pool-mfa-config REPLACES the whole MFA configuration. The pool must already send through SES (DEVELOPER).
#
# Usage:
#   back-end/scripts/cognito/otp-email.sh <user-pool-id>              # check, then apply
#   back-end/scripts/cognito/otp-email.sh <user-pool-id> --check      # only the checks; changes nothing
#   back-end/scripts/cognito/otp-email.sh <user-pool-id> --rollback   # MFA OFF: back to Cognito's default code email
# AWS_PROFILE defaults to arabica, AWS_REGION to us-east-2 (the project's only region), AWS_CLI to aws.
set -euo pipefail
pool_id=${1:?usage: otp-email.sh <user-pool-id> [--check|--rollback]}
aws_() { "${AWS_CLI:-aws}" --profile "${AWS_PROFILE:-arabica}" --region "${AWS_REGION:-us-east-2}" "$@"; }

case ${2:-} in
  ''|--check|--rollback) ;;
  *) echo "usage: otp-email.sh <user-pool-id> [--check|--rollback]" >&2; exit 2 ;;
esac

if [ "${2:-}" = "--rollback" ]; then
  aws_ cognito-idp set-user-pool-mfa-config --user-pool-id "$pool_id" --mfa-configuration OFF --output json --query MfaConfiguration
  echo "Rolled back: MFA OFF; the code email is Cognito's default again." >&2
  exit 0
fi

# 1. The pool sends through SES, and no SMS or TOTP MFA would be dropped by the replace.
[ "$(aws_ cognito-idp describe-user-pool --user-pool-id "$pool_id" --query UserPool.EmailConfiguration.EmailSendingAccount --output text)" = DEVELOPER ] \
  || { echo "Refusing: the pool does not send through SES (EmailSendingAccount DEVELOPER)." >&2; exit 1; }
mfa=$(aws_ cognito-idp get-user-pool-mfa-config --user-pool-id "$pool_id" --output json)
python3 - "$mfa" <<'PY' || { echo "Refusing: SMS or TOTP MFA is configured, and the replace would drop it." >&2; exit 1; }
import json, sys
c = json.loads(sys.argv[1])
sys.exit(1 if c.get("SmsMfaConfiguration") or (c.get("SoftwareTokenMfaConfiguration") or {}).get("Enabled") else 0)
PY

# 2. No user has an MFA preference: with OPTIONAL they would get a second code.
with_mfa=0
for user in $(aws_ cognito-idp list-users --user-pool-id "$pool_id" --query 'Users[].Username' --output text); do
  prefs=$(aws_ cognito-idp admin-get-user --user-pool-id "$pool_id" --username "$user" --query 'length(UserMFASettingList || `[]`)' --output text)
  [ "$prefs" = 0 ] || { echo "User $user has an MFA preference." >&2; with_mfa=1; }
done
[ "$with_mfa" = 0 ] || { echo "Refusing: clear those MFA preferences first, or they would get two codes." >&2; exit 1; }
if [ "${2:-}" = "--check" ]; then echo "Checks passed: SES sender, no SMS or TOTP MFA, no user with an MFA preference. Nothing changed." >&2; exit 0; fi

# 3. Apply the branded template with MFA OPTIONAL.
here=$(cd "$(dirname "$0")" && pwd)
config=$(python3 - "$here/otp-email.html" <<'PY'
import json, sys
message = open(sys.argv[1], encoding="utf-8").read()
assert "{####}" in message, "the template must contain {####}"
print(json.dumps({"Message": message, "Subject": "Tu código ArabicaAI · Seu código · Your code"}))
PY
)
aws_ cognito-idp set-user-pool-mfa-config --user-pool-id "$pool_id" --mfa-configuration OPTIONAL --email-mfa-configuration "$config" \
  --output json --query '{mfa:MfaConfiguration,subject:EmailMfaConfiguration.Subject}'
echo "Now sign in once and confirm a single branded code email arrives. To undo: $0 $pool_id --rollback" >&2
