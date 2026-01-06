#!/bin/bash
# Setup Test Scenario 3: Existing User with Default Brightness Values
# User has control-brightness enabled with default light=80%, dark=30%

SCHEMA_PATH="/org/gnome/shell/extensions/auto-theme-switcher/"

echo "=== Setting up Test Scenario 3: Default Brightness Values ==="
echo ""

# Clean slate
echo "Resetting extension settings..."
dconf reset -f "$SCHEMA_PATH"

# Set up scenario 3: Default brightness values
echo "Writing old settings format..."
dconf write "${SCHEMA_PATH}control-brightness" true
dconf write "${SCHEMA_PATH}light-brightness" 80
dconf write "${SCHEMA_PATH}dark-brightness" 30
dconf write "${SCHEMA_PATH}gradual-brightness-increase-duration" 7200
dconf write "${SCHEMA_PATH}gradual-brightness-decrease-duration" 7200

echo ""
echo "✅ Test scenario 3 configured"
echo ""
echo "Current settings:"
dconf list "$SCHEMA_PATH" | while read key; do
    value=$(dconf read "${SCHEMA_PATH}${key}")
    echo "  $key = $value"
done

echo ""
echo "Expected after migration:"
echo "  - builtin monitor created"
echo "  - lightBrightness: 80"
echo "  - darkBrightness: 30"
echo "  - enabled: true"
echo "  - old keys cleaned up"
echo ""
echo "Next: Restart extension or reload GNOME Shell to trigger migration"
