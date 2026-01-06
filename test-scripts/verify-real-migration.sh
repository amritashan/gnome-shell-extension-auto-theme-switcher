#!/bin/bash
# verify-real-migration.sh - Verify migration from real old data

SCHEMA_PATH="/org/gnome/shell/extensions/auto-theme-switcher/"
mkdir -p ~/migration-test-backups
OUTPUT_FILE=~/migration-test-backups/migration-result-$(date +%Y%m%d-%H%M%S).txt

echo "=== Migration Verification ===" | tee "$OUTPUT_FILE"
echo "" | tee -a "$OUTPUT_FILE"

# 1. Check data version
echo "1. Data Version:" | tee -a "$OUTPUT_FILE"
DATA_VERSION=$(dconf read "${SCHEMA_PATH}data-version")
echo "   data-version: $DATA_VERSION" | tee -a "$OUTPUT_FILE"

if [ "$DATA_VERSION" -eq 1 ]; then
    echo "   ✅ PASS: Version updated to 1" | tee -a "$OUTPUT_FILE"
else
    echo "   ❌ FAIL: Expected 1, got $DATA_VERSION" | tee -a "$OUTPUT_FILE"
fi
echo "" | tee -a "$OUTPUT_FILE"

# 2. Check old keys removed
echo "2. Old Keys Cleanup:" | tee -a "$OUTPUT_FILE"
OLD_LIGHT=$(dconf read "${SCHEMA_PATH}light-brightness" 2>/dev/null)
OLD_DARK=$(dconf read "${SCHEMA_PATH}dark-brightness" 2>/dev/null)

if [ -z "$OLD_LIGHT" ] && [ -z "$OLD_DARK" ]; then
    echo "   ✅ PASS: Old keys removed" | tee -a "$OUTPUT_FILE"
else
    echo "   ❌ FAIL: Old keys still present" | tee -a "$OUTPUT_FILE"
    [ ! -z "$OLD_LIGHT" ] && echo "      light-brightness: $OLD_LIGHT" | tee -a "$OUTPUT_FILE"
    [ ! -z "$OLD_DARK" ] && echo "      dark-brightness: $OLD_DARK" | tee -a "$OUTPUT_FILE"
fi
echo "" | tee -a "$OUTPUT_FILE"

# 3. Check monitors array
echo "3. Monitors Array:" | tee -a "$OUTPUT_FILE"
MONITORS_RAW=$(dconf read "${SCHEMA_PATH}monitors")
echo "   Raw: $MONITORS_RAW" | tee -a "$OUTPUT_FILE"

# Strip outer quotes and unescape JSON
# dconf returns: '[{\"id\":\"builtin\"}]'
# We need: [{\"id\":\"builtin\"}] then unescape to get valid JSON
MONITORS=$(echo "$MONITORS_RAW" | sed "s/^'//;s/'$//" | sed 's/\\"/"/g')
echo "" | tee -a "$OUTPUT_FILE"

# 4. Parse and check builtin monitor
echo "4. Builtin Monitor:" | tee -a "$OUTPUT_FILE"
echo "$MONITORS" | jq '.' > /tmp/monitors.json 2>/dev/null

if [ $? -eq 0 ]; then
    BUILTIN=$(jq '.[] | select(.id == "builtin")' /tmp/monitors.json)

    if [ ! -z "$BUILTIN" ]; then
        echo "   ✅ PASS: Builtin monitor exists" | tee -a "$OUTPUT_FILE"
        echo "" | tee -a "$OUTPUT_FILE"
        echo "   Details:" | tee -a "$OUTPUT_FILE"
        echo "$BUILTIN" | jq '{id, name, type, enabled, initialized, lightBrightness, darkBrightness, increaseDuration, decreaseDuration}' | tee -a "$OUTPUT_FILE"

        # Verify critical values
        LIGHT_BRIGHTNESS=$(echo "$BUILTIN" | jq -r '.lightBrightness')
        DARK_BRIGHTNESS=$(echo "$BUILTIN" | jq -r '.darkBrightness')
        INCREASE_DURATION=$(echo "$BUILTIN" | jq -r '.increaseDuration')
        DECREASE_DURATION=$(echo "$BUILTIN" | jq -r '.decreaseDuration')

        echo "" | tee -a "$OUTPUT_FILE"
        echo "5. Value Preservation Check:" | tee -a "$OUTPUT_FILE"

        # Expected: 85, 20, 3600, 5400 (from configuration)
        if [ "$LIGHT_BRIGHTNESS" -eq 85 ]; then
            echo "   ✅ PASS: Light brightness preserved (85)" | tee -a "$OUTPUT_FILE"
        else
            echo "   ⚠️  INFO: Light brightness is $LIGHT_BRIGHTNESS (expected 85 if configured)" | tee -a "$OUTPUT_FILE"
        fi

        if [ "$DARK_BRIGHTNESS" -eq 20 ]; then
            echo "   ✅ PASS: Dark brightness preserved (20)" | tee -a "$OUTPUT_FILE"
        else
            echo "   ⚠️  INFO: Dark brightness is $DARK_BRIGHTNESS (expected 20 if configured)" | tee -a "$OUTPUT_FILE"
        fi

        if [ "$INCREASE_DURATION" -eq 3600 ]; then
            echo "   ✅ PASS: Increase duration preserved (3600)" | tee -a "$OUTPUT_FILE"
        else
            echo "   ⚠️  INFO: Increase duration is $INCREASE_DURATION (expected 3600 if configured)" | tee -a "$OUTPUT_FILE"
        fi

        if [ "$DECREASE_DURATION" -eq 5400 ]; then
            echo "   ✅ PASS: Decrease duration preserved (5400)" | tee -a "$OUTPUT_FILE"
        else
            echo "   ⚠️  INFO: Decrease duration is $DECREASE_DURATION (expected 5400 if configured)" | tee -a "$OUTPUT_FILE"
        fi

    else
        echo "   ❌ FAIL: Builtin monitor not found!" | tee -a "$OUTPUT_FILE"
    fi
else
    echo "   ❌ FAIL: Could not parse monitors JSON" | tee -a "$OUTPUT_FILE"
fi

echo "" | tee -a "$OUTPUT_FILE"
echo "=== Summary ===" | tee -a "$OUTPUT_FILE"
echo "Check the results above. Critical tests should PASS." | tee -a "$OUTPUT_FILE"
echo "" | tee -a "$OUTPUT_FILE"
echo "Results saved to: $OUTPUT_FILE"

# Check logs for migration messages
echo "" | tee -a "$OUTPUT_FILE"
echo "=== Migration Logs (last 20 lines) ===" | tee -a "$OUTPUT_FILE"
journalctl -b | grep -E "MigrationManager|DisplayManager.*Migration" | tail -20 | tee -a "$OUTPUT_FILE"

echo ""
echo "For full logs, run:"
echo "  journalctl -b | grep MigrationManager"
