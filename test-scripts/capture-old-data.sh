#!/bin/bash
# capture-old-data.sh - Capture state before migration

SCHEMA_PATH="/org/gnome/shell/extensions/auto-theme-switcher/"
mkdir -p ~/migration-test-backups
OUTPUT_FILE=~/migration-test-backups/old-data-$(date +%Y%m%d-%H%M%S).txt

echo "=== Capturing Old Extension Data State ===" | tee "$OUTPUT_FILE"
echo "" | tee -a "$OUTPUT_FILE"
echo "Timestamp: $(date)" | tee -a "$OUTPUT_FILE"
echo "" | tee -a "$OUTPUT_FILE"

# List all keys
echo "=== All Settings Keys ===" | tee -a "$OUTPUT_FILE"
dconf list "$SCHEMA_PATH" | tee -a "$OUTPUT_FILE"
echo "" | tee -a "$OUTPUT_FILE"

# Critical keys to check
echo "=== Critical Values ===" | tee -a "$OUTPUT_FILE"
echo "control-brightness: $(dconf read ${SCHEMA_PATH}control-brightness)" | tee -a "$OUTPUT_FILE"
echo "light-brightness: $(dconf read ${SCHEMA_PATH}light-brightness)" | tee -a "$OUTPUT_FILE"
echo "dark-brightness: $(dconf read ${SCHEMA_PATH}dark-brightness)" | tee -a "$OUTPUT_FILE"
echo "gradual-brightness-increase-enabled: $(dconf read ${SCHEMA_PATH}gradual-brightness-increase-enabled)" | tee -a "$OUTPUT_FILE"
echo "gradual-brightness-increase-duration: $(dconf read ${SCHEMA_PATH}gradual-brightness-increase-duration)" | tee -a "$OUTPUT_FILE"
echo "gradual-brightness-decrease-enabled: $(dconf read ${SCHEMA_PATH}gradual-brightness-decrease-enabled)" | tee -a "$OUTPUT_FILE"
echo "gradual-brightness-decrease-duration: $(dconf read ${SCHEMA_PATH}gradual-brightness-decrease-duration)" | tee -a "$OUTPUT_FILE"

# Check for data-version (shouldn't exist in old version)
echo "" | tee -a "$OUTPUT_FILE"
echo "data-version: $(dconf read ${SCHEMA_PATH}data-version 2>&1)" | tee -a "$OUTPUT_FILE"

# Check for monitors (shouldn't exist in old version)
echo "monitors: $(dconf read ${SCHEMA_PATH}monitors 2>&1)" | tee -a "$OUTPUT_FILE"

echo "" | tee -a "$OUTPUT_FILE"
echo "=== Full Settings Dump ===" | tee -a "$OUTPUT_FILE"
dconf dump "$SCHEMA_PATH" | tee -a "$OUTPUT_FILE"

echo ""
echo "Data captured to: $OUTPUT_FILE"
echo ""
echo "=== Expected Values (verify these) ==="
echo "control-brightness: true"
echo "light-brightness: 85"
echo "dark-brightness: 20"
echo "increase-duration: 3600"
echo "decrease-duration: 5400"
