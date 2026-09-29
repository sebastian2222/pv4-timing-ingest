#!/usr/bin/env bash
# POST one valid update, then read it back. Requires INGEST_URL, GRAPHQL_URL and API_KEY.
set -euo pipefail
: "${INGEST_URL:?set INGEST_URL}"
: "${GRAPHQL_URL:?set GRAPHQL_URL}"
: "${API_KEY:?set API_KEY}"

EVENT="SMOKE-$(date +%s)"
echo "POST $EVENT"
curl -sS -X POST "$INGEST_URL" \
  -H 'content-type: application/json' \
  -d "{\"eventId\":\"$EVENT\",\"bib\":\"AUS-1\",\"lane\":1,\"revision\":1,\"status\":\"PROVISIONAL\",\"timeMs\":10105,\"recordedAt\":\"x\"}"
echo
echo "QUERY"
curl -sS -X POST "$GRAPHQL_URL" \
  -H 'content-type: application/json' \
  -H "x-api-key: $API_KEY" \
  -d "{\"query\":\"query(\$e:ID!){ events updatesRejected results(eventId:\$e){ bib lane revision status timeMs } eventStats(eventId:\$e){ eventId athletesTracked updatesAccepted updatesIgnored } }\",\"variables\":{\"e\":\"$EVENT\"}}"
echo
