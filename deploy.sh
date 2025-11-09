#!/bin/bash

# Deployment script for GNOME Shell extension
# For local development/testing - installs directly to extensions directory

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

EXTENSION_UUID="auto-theme-switcher@amritashan.github.io"
EXTENSION_DIR="$HOME/.local/share/gnome-shell/extensions/$EXTENSION_UUID"

echo "Deploying extension: $EXTENSION_UUID"
echo "Working directory: $SCRIPT_DIR"

# Warn if extension might be from extensions.gnome.org
if [ -f "$HOME/.local/share/gnome-shell/extensions/$EXTENSION_UUID/metadata.json" ]; then
    INSTALLED_VERSION=$(grep -Po '"version":\s*\K[0-9]+' "$HOME/.local/share/gnome-shell/extensions/$EXTENSION_UUID/metadata.json" 2>/dev/null || echo "")
    if [ "$INSTALLED_VERSION" != "" ] && [ "$INSTALLED_VERSION" != "999" ]; then
        echo ""
        echo "⚠️  WARNING: Extension appears to be installed from extensions.gnome.org (version: $INSTALLED_VERSION)"
        echo "   This may cause auto-update conflicts. For testing, you may want to:"
        echo "   1. Uninstall from extensions.gnome.org: gnome-extensions uninstall $EXTENSION_UUID"
        echo "   2. Or disable auto-updates in GNOME Extensions app"
        echo ""
    fi
fi

# Check if extension is currently enabled
IS_ENABLED=$(gnome-extensions info $EXTENSION_UUID 2>/dev/null | grep "State: ENABLED\|State: ACTIVE" > /dev/null && echo "yes" || echo "no")

# Disable extension if it's enabled
if [ "$IS_ENABLED" = "yes" ]; then
    echo "Disabling extension..."
    gnome-extensions disable $EXTENSION_UUID
    sleep 1
fi

# Completely remove the old extension directory to prevent conflicts
# This is necessary because extensions.gnome.org versions might be cached
if [ -d "$EXTENSION_DIR" ]; then
    echo "Removing old extension directory to prevent auto-update conflicts..."
    rm -rf "$EXTENSION_DIR"
fi

# Also remove any pending updates for this extension
UPDATES_DIR="$HOME/.local/share/gnome-shell/extension-updates/$EXTENSION_UUID"
if [ -d "$UPDATES_DIR" ]; then
    echo "Removing pending extension updates..."
    rm -rf "$UPDATES_DIR"
fi

# Create fresh extension directory
mkdir -p "$EXTENSION_DIR"

# Copy source files
echo "Copying files from $SCRIPT_DIR/src/ to $EXTENSION_DIR/"
cp -rv src/* "$EXTENSION_DIR/"

# Verify copy by showing key file timestamps
echo ""
echo "Verifying deployment:"
ls -l "$EXTENSION_DIR"/*.js | awk '{print $6, $7, $8, $9}'

# Verify that new modules are present (to catch if old version was restored)
echo ""
if [ -f "$EXTENSION_DIR/brightnessController.js" ] && [ -f "$EXTENSION_DIR/themeController.js" ]; then
    echo "✅ Local development version deployed successfully!"
    echo "   New modules detected: brightnessController.js, themeController.js, apiClient.js, timeCalculator.js"
else
    echo "❌ ERROR: New module files missing! Old version may have been restored."
    echo "   Try running: gnome-extensions uninstall $EXTENSION_UUID"
    echo "   Then run this script again."
    exit 1
fi

# Note: For GNOME 44+, schemas are compiled automatically on enable/login
# Manual compilation is only needed if you want to test immediately without restart
# For production packages (package.sh), do NOT include gschemas.compiled
echo ""
echo "Compiling schema for local testing..."
glib-compile-schemas "$EXTENSION_DIR/schemas/"

echo ""
echo "Deployment complete!"
echo ""

# Re-enable extension if it was previously enabled
if [ "$IS_ENABLED" = "yes" ]; then
    echo "Re-enabling extension..."
    gnome-extensions enable $EXTENSION_UUID
    echo ""
fi

# Restart GNOME Shell if on X11
if [ "$XDG_SESSION_TYPE" = "x11" ]; then
    echo "Restarting GNOME Shell..."
    dbus-send --type=method_call --dest=org.gnome.Shell /org/gnome/Shell org.gnome.Shell.Eval string:'global.reexec_self()'
    echo "GNOME Shell restarted!"
else
    echo "Running on Wayland - please log out and log back in to apply changes."
fi

echo ""
echo "📝 IMPORTANT NOTE:"
echo "   If the extension doesn't appear or gets replaced with the published version:"
echo "   1. Log out and log back in (this forces GNOME Shell to re-scan extensions)"
echo "   2. Make sure you uninstalled the extensions.gnome.org version first"
echo "   3. Disable auto-updates in GNOME Extensions app to prevent overwriting"
echo ""
