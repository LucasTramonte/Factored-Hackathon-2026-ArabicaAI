#!/usr/bin/env bash
# Creates or finds the Cognito user pool for email one-time-code sign-in.
# Idempotent: rerunning finds the existing pool, attribute, client and groups.
# Usage: back-end/scripts/cognito/setup.sh   (AWS_PROFILE defaults to arabica, AWS_REGION to us-east-2)
set -euo pipefail

POOL_NAME=arabicaai-demo
CLIENT_NAME=arabicaai-web
REGION=${AWS_REGION:-us-east-2}
AWS=(aws cognito-idp --profile "${AWS_PROFILE:-arabica}" --region "$REGION" --output text)

pool_id=$("${AWS[@]}" list-user-pools --max-results 60 \
  --query "UserPools[?Name=='$POOL_NAME'].Id | [0]")
if [ "$pool_id" = "None" ] || [ -z "$pool_id" ]; then
  # Cognito refuses a SignInPolicy whose first factors omit PASSWORD, so it is listed, but no user
  # is ever given a known password: the client requests EMAIL_OTP and the Worker accepts only Cognito ID tokens.
  pool_id=$("${AWS[@]}" create-user-pool --pool-name "$POOL_NAME" --user-pool-tier ESSENTIALS \
    --username-attributes email --auto-verified-attributes email \
    --admin-create-user-config AllowAdminCreateUserOnly=true \
    --policies 'SignInPolicy={AllowedFirstAuthFactors=[PASSWORD,EMAIL_OTP]}' \
    --query UserPool.Id)
  echo "created pool $pool_id" >&2
fi

# The custom attribute must exist before the app client, or the client can't read it.
if ! "${AWS[@]}" describe-user-pool --user-pool-id "$pool_id" \
     --query "UserPool.SchemaAttributes[?Name=='custom:customer_id'].Name" | grep -q customer_id; then
  "${AWS[@]}" add-custom-attributes --user-pool-id "$pool_id" --custom-attributes \
    'Name=customer_id,AttributeDataType=String,Mutable=false,StringAttributeConstraints={MinLength=1,MaxLength=64}'
  echo "added custom:customer_id" >&2
fi

client_id=$("${AWS[@]}" list-user-pool-clients --user-pool-id "$pool_id" --max-results 60 \
  --query "UserPoolClients[?ClientName=='$CLIENT_NAME'].ClientId | [0]")
if [ "$client_id" = "None" ] || [ -z "$client_id" ]; then
  client_id=$("${AWS[@]}" create-user-pool-client --user-pool-id "$pool_id" --client-name "$CLIENT_NAME" \
    --no-generate-secret --explicit-auth-flows ALLOW_USER_AUTH ALLOW_REFRESH_TOKEN_AUTH \
    --read-attributes email email_verified custom:customer_id \
    --prevent-user-existence-errors ENABLED \
    --query UserPoolClient.ClientId)
  echo "created client $client_id" >&2
fi

for g in customer agent admin auditor; do
  "${AWS[@]}" get-group --user-pool-id "$pool_id" --group-name "$g" >/dev/null 2>&1 \
    || "${AWS[@]}" create-group --user-pool-id "$pool_id" --group-name "$g" >/dev/null
done

echo "COGNITO_REGION=$REGION"
echo "COGNITO_USER_POOL_ID=$pool_id"
echo "COGNITO_CLIENT_ID=$client_id"
