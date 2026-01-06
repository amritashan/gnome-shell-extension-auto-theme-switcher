#!/bin/bash
# Setup Test Scenario 4: Existing User with Custom Brightness Values
# User has carefully configured: light=95%, dark=15%, custom durations

SCHEMA_PATH="/org/gnome/shell/extensions/auto-theme-switcher/"

echo "=== Setting up Test Scenario 4: Custom Brightness Values ==="
echo ""

# Clean slate
echo "Resetting extension settings..."
dconf reset -f "$SCHEMA_PATH"

# Set up scenario 4: Custom brightness values
echo "Writing old settings format with custom values..."
dconf write "${SCHEMA_PATH}control-brightness" true
dconf write "${SCHEMA_PATH}light-brightness" 95
dconf write "${SCHEMA_PATH}dark-brightness" 15
dconf write "${SCHEMA_PATH}gradual-brightness-increase-duration" 3600   # 1 hour
dconf write "${SCHEMA_PATH}gradual-brightness-decrease-duration" 5400   # 1.5 hours

echo ""
echo "✅ Test scenario 4 configured"
echo ""
echo "Current settings:"
dconf list "$SCHEMA_PATH" | while read key; do
    value=$(dconf read "${SCHEMA_PATH}${key}")
    echo "  $key = $value"
done

echo ""
echo "Expected after migration:"
echo "  - builtin monitor created"
echo "  - lightBrightness: 95  ← CRITICAL: Must preserve custom value!"
echo "  - darkBrightness: 15   ← CRITICAL: Must preserve custom value!"
echo "  - increaseDuration: 3600"
echo "  - decreaseDuration: 5400"
echo "  - enabled: true"
echo "  - old keys cleaned up"
echo ""
echo "⚠️  IMPORTANT: This tests that user's custom values aren't lost!"
echo ""
echo "Next: Restart extension or reload GNOME Shell to trigger migration"
