#!/bin/bash
# Verify that migration from v0 to v1 worked correctly
# Usage: ./verify-migration.sh

SCHEMA_PATH="/org/gnome/shell/extensions/auto-theme-switcher/"

echo "========================================="
echo "MIGRATION VERIFICATION (v0 → v1)"
echo "========================================="
echo "Verified at: $(date -Iseconds)"
echo ""

# Check data version
DATA_VERSION=$(dconf read "${SCHEMA_PATH}data-version" 2>/dev/null)
echo "1. Data Version Check"
if [ "$DATA_VERSION" = "1" ]; then
    echo "   ✓ data-version = 1 (correct)"
else
    echo "   ✗ data-version = ${DATA_VERSION:-NOT SET} (should be 1)"
fi
echo ""

# Check monitors array exists
echo "2. Monitors Array Check"
MONITORS=$(dconf read "${SCHEMA_PATH}monitors" 2>/dev/null)
if [ -n "$MONITORS" ]; then
    echo "   ✓ monitors array exists"

    # Check if builtin monitor exists
    if echo "$MONITORS" | grep -q '"id":"builtin"'; then
        echo "   ✓ Built-in monitor found in array"
    else
        echo "   ✗ Built-in monitor NOT found in array"
    fi

    # Show monitor count
    MONITOR_COUNT=$(echo "$MONITORS" | grep -o '"id":' | wc -l)
    echo "   → Total monitors configured: $MONITOR_COUNT"
else
    echo "   ✗ monitors array NOT found"
fi
echo ""

# Check old keys are removed
echo "3. Old Keys Cleanup Check"
OLD_KEYS_FOUND=0

for key in "light-brightness" "dark-brightness" "auto-detect-location" "use-manual-coordinates" "api-cache" "last-api-error" "last-api-error-time"; do
    if dconf read "${SCHEMA_PATH}${key}" 2>/dev/null >/dev/null; then
        echo "   ✗ Old key still exists: $key"
        OLD_KEYS_FOUND=$((OLD_KEYS_FOUND + 1))
    fi
done

if [ $OLD_KEYS_FOUND -eq 0 ]; then
    echo "   ✓ All old keys cleaned up"
else
    echo "   ✗ Found $OLD_KEYS_FOUND old keys that should be removed"
fi
echo ""

# Check location-name was initialized
echo "4. Location Name Check"
LAT=$(dconf read "${SCHEMA_PATH}manual-latitude" 2>/dev/null)
LNG=$(dconf read "${SCHEMA_PATH}manual-longitude" 2>/dev/null)
LOCATION_NAME=$(dconf read "${SCHEMA_PATH}location-name" 2>/dev/null)

if [ -n "$LAT" ] && [ -n "$LNG" ]; then
    if [ -n "$LOCATION_NAME" ] && [ "$LOCATION_NAME" != "''" ]; then
        echo "   ✓ location-name initialized: $LOCATION_NAME"
    else
        echo "   ✗ Coordinates exist but location-name not set"
    fi
else
    echo "   ⚠ No coordinates set (location-name not applicable)"
fi
echo ""

# Check preserved settings
echo "5. Preserved Settings Check"
echo "   Theme settings:"
echo "     light-theme: $(dconf read ${SCHEMA_PATH}light-theme 2>/dev/null || echo 'NOT SET')"
echo "     dark-theme: $(dconf read ${SCHEMA_PATH}dark-theme 2>/dev/null || echo 'NOT SET')"
echo "   Brightness control:"
echo "     control-brightness: $(dconf read ${SCHEMA_PATH}control-brightness 2>/dev/null || echo 'NOT SET')"
echo "   Location:"
echo "     manual-latitude: $(dconf read ${SCHEMA_PATH}manual-latitude 2>/dev/null || echo 'NOT SET')"
echo "     manual-longitude: $(dconf read ${SCHEMA_PATH}manual-longitude 2>/dev/null || echo 'NOT SET')"
echo ""

# Summary
echo "========================================="
echo "MIGRATION SUMMARY"
echo "========================================="

CHECKS_PASSED=0
CHECKS_TOTAL=4

[ "$DATA_VERSION" = "1" ] && CHECKS_PASSED=$((CHECKS_PASSED + 1))
[ -n "$MONITORS" ] && CHECKS_PASSED=$((CHECKS_PASSED + 1))
[ $OLD_KEYS_FOUND -eq 0 ] && CHECKS_PASSED=$((CHECKS_PASSED + 1))
[ -z "$LAT" ] || [ -n "$LOCATION_NAME" ] && CHECKS_PASSED=$((CHECKS_PASSED + 1))

echo "Checks passed: $CHECKS_PASSED / $CHECKS_TOTAL"

if [ $CHECKS_PASSED -eq $CHECKS_TOTAL ]; then
    echo "✓ Migration completed successfully!"
    exit 0
else
    echo "✗ Migration has issues that need attention"
    exit 1
fi
