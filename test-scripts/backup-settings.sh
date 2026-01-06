#!/bin/bash
# Backup extension settings with timestamp
# Usage: ./backup-settings.sh [label]

LABEL="${1:-backup}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="settings-backup-${LABEL}-${TIMESTAMP}.dconf"
SCHEMA_PATH="/org/gnome/shell/extensions/auto-theme-switcher/"

echo "Backing up settings to: $BACKUP_FILE"
dconf dump "$SCHEMA_PATH" > "$BACKUP_FILE"

if [ $? -eq 0 ]; then
    echo "✓ Backup saved successfully"
    echo "To restore: dconf load $SCHEMA_PATH < $BACKUP_FILE"
else
    echo "✗ Backup failed"
    exit 1
fi
