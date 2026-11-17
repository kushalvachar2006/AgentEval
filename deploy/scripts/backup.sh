#!/usr/bin/env bash
# Back up the AgentEval MongoDB (everything lives there) to a compressed archive.
#   deploy/scripts/backup.sh [output-dir]        (default: ./backups)
# Run from the project folder. Works with the standard docker compose setup. Schedule it with cron (see docs/operations/BACKUP_RESTORE.md).
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT="${1:-backups}"
mkdir -p "$OUT"
FILE="$OUT/agenteval-$(date -u +%Y%m%dT%H%M%SZ).archive.gz"
# Credentials come from the container's own environment, never from the command line or this script.
docker compose exec -T mongo sh -c 'mongodump --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --db agenteval --archive --gzip' > "$FILE"
[ -s "$FILE" ] || { echo "Backup is empty - something went wrong" >&2; rm -f "$FILE"; exit 1; }
chmod 600 "$FILE"
echo "Backup written: $FILE ($(du -h "$FILE" | cut -f1))"
echo "Keep a copy OFF this server. The archive contains encrypted secrets; keep your ENCRYPTION_KEY (in .env) safe too - without it provider keys / webhook URLs in the backup cannot be decrypted."
