#!/bin/bash
# Emergency Reset Script
# Use this if migration goes wrong and you need to reset to defaults

SCHEMA_PATH="/org/gnome/shell/extensions/auto-theme-switcher/"

echo "⚠️  ⚠️  ⚠️  EMERGENCY RESET  ⚠️  ⚠️  ⚠️"
echo ""
echo "This will:"
echo "  - Reset ALL extension settings to defaults"
echo "  - Remove all monitor configurations"
echo "  - You will need to reconfigure everything"
echo ""
read -p "Are you absolutely sure? Type 'yes' to continue: " CONFIRM

if [ "$CONFIRM" != "yes" ]; then
    echo "Cancelled."
    exit 0
fi

echo ""
echo "Creating emergency backup first..."
BACKUP_DIR="$HOME/.config/auto-theme-switcher-backups"
mkdir -p "$BACKUP_DIR"
BACKUP_FILE="$BACKUP_DIR/emergency-backup-$(date +%Y%m%d-%H%M%S).dconf"
dconf dump "$SCHEMA_PATH" > "$BACKUP_FILE"
echo "Backup saved to: $BACKUP_FILE"

echo ""
echo "Resetting all settings..."
dconf reset -f "$SCHEMA_PATH"

echo ""
echo "Setting up minimal defaults..."

# Create a basic builtin monitor entry
DEFAULT_MONITORS='[{"id":"builtin","name":"Built-in Display","type":"brightnessctl","enabled":false,"initialized":false,"lightBrightness":80,"darkBrightness":30,"increaseDuration":7200,"decreaseDuration":7200,"lastSeen":0}]'

dconf write "${SCHEMA_PATH}monitors" "'$DEFAULT_MONITORS'"
dconf write "${SCHEMA_PATH}control-brightness" false
dconf write "${SCHEMA_PATH}gradual-brightness-increase-duration" 7200
dconf write "${SCHEMA_PATH}gradual-brightness-decrease-duration" 7200

echo ""
echo "✅ Reset complete!"
echo ""
echo "Current settings:"
dconf list "$SCHEMA_PATH" | while read key; do
    value=$(dconf read "${SCHEMA_PATH}${key}")
    echo "  $key = $value"
done

echo ""
echo "Next steps:"
echo "  1. Restart GNOME Shell (Alt+F2, type 'r', Enter)"
echo "     Or log out and log back in"
echo "  2. Open extension preferences"
echo "  3. Reconfigure your settings"
echo ""
echo "To restore from backup:"
echo "  dconf load $SCHEMA_PATH < $BACKUP_FILE"
