#!/bin/bash
# clean-slate.sh - Complete cleanup for fresh migration test

SCHEMA_PATH="/org/gnome/shell/extensions/auto-theme-switcher/"
UUID="auto-theme-switcher@amritashan.github.io"

echo "=== Cleaning Slate for Fresh Migration Test ==="
echo ""

# 1. Disable and uninstall extension (if installed)
echo "1. Removing extension..."
gnome-extensions disable "$UUID" 2>/dev/null
gnome-extensions uninstall "$UUID" 2>/dev/null

# Also remove from local extensions directory
rm -rf ~/.local/share/gnome-shell/extensions/"$UUID"

echo "   ✓ Extension removed"
echo ""

# 2. Wipe ALL settings data
echo "2. Wiping all settings data..."
dconf reset -f "$SCHEMA_PATH"

echo "   ✓ All settings wiped"
echo ""

# 3. Verify clean state
echo "3. Verifying clean state..."
REMAINING=$(dconf list "$SCHEMA_PATH" 2>/dev/null | wc -l)

if [ "$REMAINING" -eq 0 ]; then
    echo "   ✓ Clean slate confirmed - no settings remain"
else
    echo "   ⚠️  Warning: $REMAINING settings still present"
    dconf list "$SCHEMA_PATH"
fi

echo ""
echo "=== Clean Slate Complete ==="
echo "Ready to install published extension"
