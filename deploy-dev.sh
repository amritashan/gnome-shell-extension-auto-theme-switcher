#!/bin/bash

# Development deployment script for GNOME Shell extension
# Creates a separate "-dev" version that won't conflict with production
# or receive auto-updates from extensions.gnome.org

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Production and dev UUIDs
PROD_UUID="auto-theme-switcher@amritashan.github.io"
DEV_UUID="auto-theme-switcher-dev@amritashan.github.io"

# Schema names
PROD_SCHEMA="org.gnome.shell.extensions.auto-theme-switcher"
DEV_SCHEMA="org.gnome.shell.extensions.auto-theme-switcher-dev"

# Directories
BUILD_DEV_DIR="$SCRIPT_DIR/build-dev"
EXTENSION_DIR="$HOME/.local/share/gnome-shell/extensions/$DEV_UUID"

echo "========================================"
echo "  DEV BUILD DEPLOYMENT"
echo "========================================"
echo ""
echo "This creates a separate development version:"
echo "  UUID: $DEV_UUID"
echo "  Schema: $DEV_SCHEMA"
echo ""
echo "The production version ($PROD_UUID) will NOT be affected."
echo ""

# Check if extension is currently enabled
IS_ENABLED=$(gnome-extensions info "$DEV_UUID" 2>/dev/null | grep -E "State: ENABLED|State: ACTIVE" > /dev/null && echo "yes" || echo "no")

# Disable extension if it's enabled
if [ "$IS_ENABLED" = "yes" ]; then
    echo "Disabling dev extension..."
    gnome-extensions disable "$DEV_UUID"
    sleep 1
fi

# Clean and create build-dev directory
echo "Preparing dev build..."
rm -rf "$BUILD_DEV_DIR"
mkdir -p "$BUILD_DEV_DIR"

# Copy source files to build-dev
cp -r src/* "$BUILD_DEV_DIR/"

# Modify metadata.json for dev version
echo "Patching metadata.json for dev..."
sed -i \
    -e "s|\"uuid\": \"$PROD_UUID\"|\"uuid\": \"$DEV_UUID\"|g" \
    -e "s|\"name\": \"Automatic Theme Switcher\"|\"name\": \"Automatic Theme Switcher (DEV)\"|g" \
    -e "s|\"settings-schema\": \"$PROD_SCHEMA\"|\"settings-schema\": \"$DEV_SCHEMA\"|g" \
    "$BUILD_DEV_DIR/metadata.json"

# Rename and modify schema file for dev version
echo "Patching schema for dev..."
mv "$BUILD_DEV_DIR/schemas/$PROD_SCHEMA.gschema.xml" \
   "$BUILD_DEV_DIR/schemas/$DEV_SCHEMA.gschema.xml"

sed -i \
    -e "s|id=\"$PROD_SCHEMA\"|id=\"$DEV_SCHEMA\"|g" \
    -e "s|path=\"/org/gnome/shell/extensions/auto-theme-switcher/\"|path=\"/org/gnome/shell/extensions/auto-theme-switcher-dev/\"|g" \
    "$BUILD_DEV_DIR/schemas/$DEV_SCHEMA.gschema.xml"

# Remove old extension directory and create fresh one
if [ -d "$EXTENSION_DIR" ]; then
    echo "Removing old dev extension directory..."
    rm -rf "$EXTENSION_DIR"
fi
mkdir -p "$EXTENSION_DIR"

# Copy dev build to extension directory
echo "Installing dev extension to $EXTENSION_DIR..."
cp -r "$BUILD_DEV_DIR"/* "$EXTENSION_DIR/"

# Compile schema
echo "Compiling schema..."
glib-compile-schemas "$EXTENSION_DIR/schemas/"

echo ""
echo "========================================"
echo "  DEV DEPLOYMENT COMPLETE"
echo "========================================"
echo ""
echo "Installed files:"
ls -la "$EXTENSION_DIR"/*.js 2>/dev/null | awk '{print "  " $9}' | xargs -I{} basename {}
echo ""

# Verify the modifications
echo "Verification:"
DEV_NAME=$(grep -Po '"name":\s*"\K[^"]+' "$EXTENSION_DIR/metadata.json")
DEV_UUID_CHECK=$(grep -Po '"uuid":\s*"\K[^"]+' "$EXTENSION_DIR/metadata.json")
DEV_SCHEMA_CHECK=$(grep -Po '"settings-schema":\s*"\K[^"]+' "$EXTENSION_DIR/metadata.json")
echo "  Name: $DEV_NAME"
echo "  UUID: $DEV_UUID_CHECK"
echo "  Schema: $DEV_SCHEMA_CHECK"
echo ""

if [ "$DEV_UUID_CHECK" = "$DEV_UUID" ] && [ "$DEV_SCHEMA_CHECK" = "$DEV_SCHEMA" ]; then
    echo "✅ Dev version configured correctly!"
else
    echo "❌ ERROR: Dev configuration mismatch!"
    exit 1
fi

# Re-enable extension if it was previously enabled
if [ "$IS_ENABLED" = "yes" ]; then
    echo ""
    echo "Re-enabling dev extension..."
    gnome-extensions enable "$DEV_UUID"
fi

echo ""
# Restart GNOME Shell if on X11
if [ "$XDG_SESSION_TYPE" = "x11" ]; then
    echo "Restarting GNOME Shell..."
    dbus-send --type=method_call --dest=org.gnome.Shell /org/gnome/Shell org.gnome.Shell.Eval string:'global.reexec_self()'
    echo "GNOME Shell restarted!"
else
    echo "Running on Wayland - please log out and log back in to apply changes."
fi

echo ""
echo "📝 NOTES:"
echo "   - Dev extension appears as: 'Automatic Theme Switcher (DEV)'"
echo "   - Settings are stored separately from production"
echo "   - No auto-updates will affect this version"
echo "   - You can have both production and dev installed simultaneously"
echo ""
echo "To enable:  gnome-extensions enable $DEV_UUID"
echo "To disable: gnome-extensions disable $DEV_UUID"
echo "To remove:  gnome-extensions uninstall $DEV_UUID"
echo ""
