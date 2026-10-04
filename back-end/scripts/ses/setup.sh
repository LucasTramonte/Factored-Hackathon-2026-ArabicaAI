#!/usr/bin/env bash
# Creates or finds the SES sender identity (a domain or an address), the Worker's send-only IAM user, and the
# bounce/complaint handling SES production access requires: the account suppression list, a configuration set that is
# the identity's default (so the Worker's sends use it with no code change) with an SNS destination for BOUNCE and
# COMPLAINT events, and CloudWatch alarms on the account's reputation rates, set well under AWS's review thresholds
# (5% bounce, 0.1% complaint). Idempotent. Never creates an access key: a person does that (Docs/Plans/intake-demo.md).
# Usage: SES_IDENTITY=<domain or address> ALERT_EMAIL=<who gets bounce/complaint/alarm mail> back-end/scripts/ses/setup.sh
#   (AWS_PROFILE defaults to arabica). A domain identity gets Easy DKIM: publish the CNAMEs it prints, plus a custom
#   MAIL FROM and _dmarc, where the domain's DNS lives. Addresses are never committed (issue #70).
set -euo pipefail

IDENTITY=${SES_IDENTITY:?set SES_IDENTITY to the sender domain or address}
ALERT=${ALERT_EMAIL:?set ALERT_EMAIL to the address that receives bounce, complaint and alarm notifications}
USER_NAME=arabicaai-worker-ses
CONFIG_SET=arabicaai
TOPIC=arabicaai-ses-events
REGION=us-east-2
P=(--profile "${AWS_PROFILE:-arabica}" --output text)
SES=(aws sesv2 "${P[@]}" --region "$REGION")
CW=(aws cloudwatch "${P[@]}" --region "$REGION")

if ! "${SES[@]}" get-email-identity --email-identity "$IDENTITY" >/dev/null 2>&1; then
  "${SES[@]}" create-email-identity --email-identity "$IDENTITY" >/dev/null
  echo "created identity $IDENTITY (an address gets a verification link; a domain needs its DKIM CNAMEs published)" >&2
fi

account=$(aws sts get-caller-identity "${P[@]}" --query Account)
aws iam get-user "${P[@]}" --user-name "$USER_NAME" >/dev/null 2>&1 \
  || { aws iam create-user "${P[@]}" --user-name "$USER_NAME" >/dev/null; echo "created user $USER_NAME" >&2; }
# put-user-policy overwrites, so rerunning keeps the policy exact: this identity only (least privilege).
aws iam put-user-policy "${P[@]}" --user-name "$USER_NAME" --policy-name ses-send-only --policy-document "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [{\"Effect\": \"Allow\", \"Action\": \"ses:SendEmail\",
    \"Resource\": \"arn:aws:ses:$REGION:$account:identity/$IDENTITY\"}]
}"

# Bounces and complaints: suppress repeat sends, publish the events, alarm on the account's rates.
"${SES[@]}" put-account-suppression-attributes --suppressed-reasons BOUNCE COMPLAINT
topic_arn=$(aws sns "${P[@]}" --region "$REGION" create-topic --name "$TOPIC" --query TopicArn)   # idempotent
aws sns "${P[@]}" --region "$REGION" list-subscriptions-by-topic --topic-arn "$topic_arn" --query "Subscriptions[?Endpoint=='$ALERT'].SubscriptionArn" | grep -q . \
  || { aws sns "${P[@]}" --region "$REGION" subscribe --topic-arn "$topic_arn" --protocol email --notification-endpoint "$ALERT" >/dev/null; echo "subscribed $ALERT to $TOPIC; confirm the email SNS sent" >&2; }
"${SES[@]}" get-configuration-set --configuration-set-name "$CONFIG_SET" >/dev/null 2>&1 \
  || "${SES[@]}" create-configuration-set --configuration-set-name "$CONFIG_SET" >/dev/null
destination="{\"Enabled\": true, \"MatchingEventTypes\": [\"BOUNCE\", \"COMPLAINT\"], \"SnsDestination\": {\"TopicArn\": \"$topic_arn\"}}"
"${SES[@]}" get-configuration-set-event-destinations --configuration-set-name "$CONFIG_SET" --query "EventDestinations[?Name=='$TOPIC'].Name" | grep -q . \
  && "${SES[@]}" update-configuration-set-event-destination --configuration-set-name "$CONFIG_SET" --event-destination-name "$TOPIC" --event-destination "$destination" \
  || "${SES[@]}" create-configuration-set-event-destination --configuration-set-name "$CONFIG_SET" --event-destination-name "$TOPIC" --event-destination "$destination"
"${SES[@]}" put-email-identity-configuration-set-attributes --email-identity "$IDENTITY" --configuration-set-name "$CONFIG_SET"
for pair in "Reputation.BounceRate 0.02" "Reputation.ComplaintRate 0.0005"; do
  set -- $pair
  "${CW[@]}" put-metric-alarm --alarm-name "arabicaai-ses-$1" --namespace AWS/SES --metric-name "$1" \
    --statistic Average --period 3600 --evaluation-periods 1 --threshold "$2" --comparison-operator GreaterThanThreshold \
    --treat-missing-data notBreaching --alarm-actions "$topic_arn" \
    --alarm-description "SES account $1 over $2 (AWS reviews at 5% bounce, 0.1% complaint). Docs/Plans/intake-demo.md"
done

echo "SES_IDENTITY=$IDENTITY verified=$("${SES[@]}" get-email-identity --email-identity "$IDENTITY" --query VerifiedForSendingStatus) config_set=$CONFIG_SET"
echo "SES_USER_ARN=$(aws iam get-user "${P[@]}" --user-name "$USER_NAME" --query User.Arn)"
echo "SES_EVENTS_TOPIC=$topic_arn alarms=arabicaai-ses-Reputation.BounceRate,arabicaai-ses-Reputation.ComplaintRate"
