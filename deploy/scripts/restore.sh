#!/usr/bin/env bash
# Restore a backup made by backup.sh into the running MongoDB. DESTRUCTIVE: existing agenteval data is replaced.
#   deploy/scripts/restore.sh backups/agenteval-XXXX.archive.gz
set -euo pipefail
cd "$(dirname "$0")/../.."
FILE="${1:?usage: restore.sh <archive.gz>}"
[ -f "$FILE" ] || { echo "No such file: $FILE" >&2; exit 1; }
echo "This REPLACES all current AgentEval data with the contents of $FILE."
read -r -p "Type RESTORE to continue: " ANSWER
[ "$ANSWER" = "RESTORE" ] || { echo "Cancelled."; exit 1; }
docker compose stop api worker web >/dev/null
docker compose exec -T mongo sh -c 'mongorestore --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --archive --gzip --drop' < "$FILE"
docker compose start api worker web >/dev/null
echo "Restore finished. Check: npm run doctor"
