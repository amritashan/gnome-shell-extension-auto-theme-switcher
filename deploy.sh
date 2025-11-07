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

# Check if extension is currently enabled
IS_ENABLED=$(gnome-extensions info $EXTENSION_UUID 2>/dev/null | grep "State: ENABLED\|State: ACTIVE" > /dev/null && echo "yes" || echo "no")

# Disable extension if it's enabled
if [ "$IS_ENABLED" = "yes" ]; then
    echo "Disabling extension..."
    gnome-extensions disable $EXTENSION_UUID
fi

# Create the extension directory if it doesn't exist
mkdir -p "$EXTENSION_DIR"

# Copy source files
echo "Copying files from $SCRIPT_DIR/src/ to $EXTENSION_DIR/"
cp -rv src/* "$EXTENSION_DIR/"

# Verify copy by showing key file timestamps
echo ""
echo "Verifying deployment:"
ls -l "$EXTENSION_DIR"/*.js | awk '{print $6, $7, $8, $9}'

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
