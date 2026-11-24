#!/usr/bin/env bash

set -Eeuo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <host>"
  echo "Example: $0 http://localhost:3000"
  exit 1
fi

for dependency in curl jq; do
  if ! command -v "$dependency" >/dev/null 2>&1; then
    echo "Required command not found: $dependency" >&2
    exit 1
  fi
done

HOST=$1
while [[ "$HOST" == */ ]]; do
  HOST=${HOST%/}
done

CURL_TIMEOUT=${CURL_TIMEOUT:-30}
TRAFFIC_INTERVAL=${TRAFFIC_INTERVAL:-30}
TRAFFIC_ONCE=${TRAFFIC_ONCE:-0}
ADMIN_EMAIL=${ADMIN_EMAIL:-a@jwt.com}
ADMIN_PASSWORD=${ADMIN_PASSWORD:-admin}
TRAFFIC_EMAIL=${TRAFFIC_EMAIL:-pizza-traffic@jwt.com}
TRAFFIC_PASSWORD=${TRAFFIC_PASSWORD:-pizza-traffic-test-only}
TRAFFIC_NAME='Pizza Traffic User'
TEMP_FRANCHISE_ID=''
TEMP_STORE_ID=''
ADMIN_TOKEN=''
DINER_TOKEN=''
HTTP_STATUS=''
HTTP_BODY=''

if [[ ! "$TRAFFIC_INTERVAL" =~ ^[1-9][0-9]*$ ]]; then
  echo "TRAFFIC_INTERVAL must be a positive number of seconds" >&2
  exit 1
fi

request() {
  local method=$1
  local url=$2
  local response
  shift 2

  if ! response=$(curl --silent --show-error --max-time "$CURL_TIMEOUT" \
    --request "$method" "$url" "$@" --write-out $'\n%{http_code}'); then
    HTTP_STATUS=000
    HTTP_BODY=''
    echo "Request failed: $method $url (curl timeout or connection error; limit ${CURL_TIMEOUT}s)" >&2
    return 1
  fi

  HTTP_STATUS=${response##*$'\n'}
  HTTP_BODY=${response%$'\n'*}
}

expect_status() {
  local label=$1
  local expected
  shift

  for expected in "$@"; do
    if [[ "$HTTP_STATUS" == "$expected" ]]; then
      echo "$label [$HTTP_STATUS]"
      return 0
    fi
  done

  echo "$label failed: expected HTTP $*, received $HTTP_STATUS" >&2
  return 1
}

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM
  set +e

  if [[ -n "$TEMP_STORE_ID" && -n "$TEMP_FRANCHISE_ID" && -n "$ADMIN_TOKEN" ]]; then
    request DELETE "$HOST/api/franchise/$TEMP_FRANCHISE_ID/store/$TEMP_STORE_ID" \
      -H "Authorization: Bearer $ADMIN_TOKEN"
    echo "Cleanup temporary store [$HTTP_STATUS]"
  fi

  if [[ -n "$TEMP_FRANCHISE_ID" && -n "$ADMIN_TOKEN" ]]; then
    request DELETE "$HOST/api/franchise/$TEMP_FRANCHISE_ID" \
      -H "Authorization: Bearer $ADMIN_TOKEN"
    echo "Cleanup temporary franchise [$HTTP_STATUS]"
  fi

  if [[ -n "$DINER_TOKEN" ]]; then
    request DELETE "$HOST/api/auth" -H "Authorization: Bearer $DINER_TOKEN"
    echo "Logout traffic user [$HTTP_STATUS]"
  fi

  if [[ -n "$ADMIN_TOKEN" ]]; then
    request DELETE "$HOST/api/auth" -H "Authorization: Bearer $ADMIN_TOKEN"
    echo "Logout admin [$HTTP_STATUS]"
  fi

  exit "$exit_code"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "Simulating traffic against $HOST"

request GET "$HOST/"
expect_status "GET /" 200

request GET "$HOST/checkDeployment"
expect_status "GET /checkDeployment" 200

request GET "$HOST/api/docs"
expect_status "GET /api/docs" 200

admin_login_body=$(jq -n --arg email "$ADMIN_EMAIL" --arg password "$ADMIN_PASSWORD" \
  '{email: $email, password: $password}')
request PUT "$HOST/api/auth" -H 'Content-Type: application/json' --data "$admin_login_body"
expect_status "PUT /api/auth (admin login)" 200
ADMIN_TOKEN=$(jq -er '.token | strings | select(length > 0)' <<<"$HTTP_BODY")

traffic_login_body=$(jq -n --arg email "$TRAFFIC_EMAIL" --arg password "$TRAFFIC_PASSWORD" \
  '{email: $email, password: $password}')
request PUT "$HOST/api/auth" -H 'Content-Type: application/json' --data "$traffic_login_body"
if [[ "$HTTP_STATUS" == 200 ]]; then
  echo "PUT /api/auth (traffic user login) [$HTTP_STATUS]"
  DINER_TOKEN=$(jq -er '.token | strings | select(length > 0)' <<<"$HTTP_BODY")
else
  if [[ "$HTTP_STATUS" != 404 ]]; then
    expect_status "PUT /api/auth (traffic user login)" 200
  fi

  echo "Traffic user is not registered; registering the stable test account."
  registration_body=$(jq -n --arg name "$TRAFFIC_NAME" --arg email "$TRAFFIC_EMAIL" \
    --arg password "$TRAFFIC_PASSWORD" '{name: $name, email: $email, password: $password}')
  request POST "$HOST/api/auth" -H 'Content-Type: application/json' --data "$registration_body"
  expect_status "POST /api/auth (register traffic user)" 200
  DINER_TOKEN=$(jq -er '.token | strings | select(length > 0)' <<<"$HTTP_BODY")
fi

request PUT "$HOST/api/auth" -H 'Content-Type: application/json' \
  --data '{"email":"unknown-traffic-user@invalid.example","password":"incorrect"}'
expect_status "PUT /api/auth (invalid login)" 404

request GET "$HOST/api/order/menu"
expect_status "GET /api/order/menu" 200
menu_item=$(jq -ce '.[0] | {menuId: .id, description: .title, price: .price}' <<<"$HTTP_BODY")

request GET "$HOST/api/user/me" -H "Authorization: Bearer $DINER_TOKEN"
expect_status "GET /api/user/me" 200
DINER_USER_ID=$(jq -er '.id' <<<"$HTTP_BODY")
diner_name=$(jq -er '.name' <<<"$HTTP_BODY")
diner_email=$(jq -er '.email' <<<"$HTTP_BODY")

request GET "$HOST/api/user?page=1&limit=10&name=Pizza%20Traffic%20User" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
expect_status "GET /api/user" 200

update_user_body=$(jq -n --arg name "$diner_name" --arg email "$diner_email" \
  '{name: $name, email: $email}')
old_diner_token=$DINER_TOKEN
request PUT "$HOST/api/user/$DINER_USER_ID" -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $old_diner_token" --data "$update_user_body"
expect_status "PUT /api/user/:userId" 200
DINER_TOKEN=$(jq -er '.token | strings | select(length > 0)' <<<"$HTTP_BODY")
if [[ "$DINER_TOKEN" != "$old_diner_token" ]]; then
  request DELETE "$HOST/api/auth" -H "Authorization: Bearer $old_diner_token"
  expect_status "DELETE /api/auth (retire old traffic token)" 200
fi

request DELETE "$HOST/api/user/0" -H "Authorization: Bearer $ADMIN_TOKEN"
expect_status "DELETE /api/user/:userId (invalid ID, no deletion)" 400

request GET "$HOST/api/franchise?page=0&limit=10"
expect_status "GET /api/franchise" 200
order_location=$(jq -r \
  '[.franchises[]? as $franchise | $franchise.stores[]? | select(.id != null) | [$franchise.id, .id] | @tsv] | first // empty' \
  <<<"$HTTP_BODY")

request GET "$HOST/api/franchise/$DINER_USER_ID" -H "Authorization: Bearer $DINER_TOKEN"
expect_status "GET /api/franchise/:userId" 200

request GET "$HOST/api/order" -H "Authorization: Bearer $DINER_TOKEN"
expect_status "GET /api/order" 200
existing_order_count=$(jq -er '.orders | length' <<<"$HTTP_BODY")

if [[ "$existing_order_count" -eq 0 ]]; then
  order_franchise_id=1
  order_store_id=1
  if [[ -n "$order_location" ]]; then
    IFS=$'\t' read -r order_franchise_id order_store_id <<<"$order_location"
  fi

  order_body=$(jq -n --argjson franchiseId "$order_franchise_id" \
    --argjson storeId "$order_store_id" --argjson item "$menu_item" \
    '{franchiseId: $franchiseId, storeId: $storeId, items: [$item]}')
  request POST "$HOST/api/order" -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $DINER_TOKEN" --data "$order_body"
  expect_status "POST /api/order (one-time traffic order)" 200 500

  request GET "$HOST/api/order" -H "Authorization: Bearer $DINER_TOKEN"
  expect_status "GET /api/order (verify stored order)" 200
  if [[ "$(jq -er '.orders | length' <<<"$HTTP_BODY")" -eq 0 ]]; then
    echo "POST /api/order did not create an order" >&2
    exit 1
  fi
else
  echo "Skipping POST /api/order; the stable traffic user already has an order."
fi

temp_franchise_name="pizza-traffic-${HOST//[^a-zA-Z0-9]/}-${BASHPID}-$(date +%s)"
franchise_body=$(jq -n --arg name "$temp_franchise_name" --arg email "$ADMIN_EMAIL" \
  '{name: $name, admins: [{email: $email}]}')
request POST "$HOST/api/franchise" -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ADMIN_TOKEN" --data "$franchise_body"
expect_status "POST /api/franchise (temporary)" 200
TEMP_FRANCHISE_ID=$(jq -er '.id' <<<"$HTTP_BODY")

request GET "$HOST/api/franchise?name=$temp_franchise_name"
expect_status "GET /api/franchise?name=..." 200

store_body=$(jq -n --arg name "Traffic Test Store" '{name: $name}')
request POST "$HOST/api/franchise/$TEMP_FRANCHISE_ID/store" \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $ADMIN_TOKEN" \
  --data "$store_body"
expect_status "POST /api/franchise/:franchiseId/store" 200
TEMP_STORE_ID=$(jq -er '.id' <<<"$HTTP_BODY")

request DELETE "$HOST/api/franchise/$TEMP_FRANCHISE_ID/store/$TEMP_STORE_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
expect_status "DELETE /api/franchise/:franchiseId/store/:storeId" 200
TEMP_STORE_ID=''

request DELETE "$HOST/api/franchise/$TEMP_FRANCHISE_ID" -H "Authorization: Bearer $ADMIN_TOKEN"
expect_status "DELETE /api/franchise/:franchiseId" 200
TEMP_FRANCHISE_ID=''

if [[ "$TRAFFIC_ONCE" == 1 ]]; then
  exit 0
fi

echo "Read-only traffic repeats every $TRAFFIC_INTERVAL seconds. Press Ctrl+C to stop."
while true; do
  sleep "$TRAFFIC_INTERVAL"

  request GET "$HOST/api/order/menu"
  expect_status "GET /api/order/menu" 200

  request GET "$HOST/api/order" -H "Authorization: Bearer $DINER_TOKEN"
  expect_status "GET /api/order" 200

  request GET "$HOST/api/franchise?page=0&limit=10"
  expect_status "GET /api/franchise" 200

  request GET "$HOST/api/franchise/$DINER_USER_ID" -H "Authorization: Bearer $DINER_TOKEN"
  expect_status "GET /api/franchise/:userId" 200

  request GET "$HOST/api/user/me" -H "Authorization: Bearer $DINER_TOKEN"
  expect_status "GET /api/user/me" 200

  request GET "$HOST/api/user?page=1&limit=10&name=Pizza%20Traffic%20User" \
    -H "Authorization: Bearer $ADMIN_TOKEN"
  expect_status "GET /api/user" 200
done
