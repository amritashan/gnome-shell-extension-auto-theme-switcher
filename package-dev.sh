#!/bin/bash

# Build and package script for GNOME Shell extension (DEV version)
# Creates a separate "-dev" package that won't conflict with production
# Usage:
#   ./package-dev.sh        - Build and create dev package
#   ./package-dev.sh build  - Only build (copy files to build-dev/)

set -e  # Exit on error

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Production and dev identifiers
PROD_UUID="auto-theme-switcher@amritashan.github.io"
DEV_UUID="auto-theme-switcher-dev@amritashan.github.io"
PROD_SCHEMA="org.gnome.shell.extensions.auto-theme-switcher"
DEV_SCHEMA="org.gnome.shell.extensions.auto-theme-switcher-dev"

SRC_DIR="src"
BUILD_DIR="build-dev"
PACKAGE_NAME="${DEV_UUID}.shell-extension.zip"
PACKAGE_PATH="$BUILD_DIR/$PACKAGE_NAME"

build_extension() {
    echo "Building GNOME Shell extension (DEV): $DEV_UUID"

    # Clean previous build
    rm -rf "$BUILD_DIR"
    mkdir -p "$BUILD_DIR"

    # Copy ALL source files to build directory
    echo "Copying all files from $SRC_DIR/ to $BUILD_DIR/..."
    cp -rv "$SRC_DIR"/* "$BUILD_DIR/"

    # Remove tests — development-only, not part of the shipped extension
    rm -rf "$BUILD_DIR/tests"

    # Patch metadata.json for dev version
    echo ""
    echo "Patching metadata.json for dev..."
    sed -i \
        -e "s|\"uuid\": \"$PROD_UUID\"|\"uuid\": \"$DEV_UUID\"|g" \
        -e "s|\"name\": \"Automatic Theme Switcher\"|\"name\": \"Automatic Theme Switcher (DEV)\"|g" \
        -e "s|\"settings-schema\": \"$PROD_SCHEMA\"|\"settings-schema\": \"$DEV_SCHEMA\"|g" \
        "$BUILD_DIR/metadata.json"

    # Rename and patch schema file for dev version
    echo "Patching schema for dev..."
    mv "$BUILD_DIR/schemas/$PROD_SCHEMA.gschema.xml" \
       "$BUILD_DIR/schemas/$DEV_SCHEMA.gschema.xml"

    sed -i \
        -e "s|id=\"$PROD_SCHEMA\"|id=\"$DEV_SCHEMA\"|g" \
        -e "s|path=\"/org/gnome/shell/extensions/auto-theme-switcher/\"|path=\"/org/gnome/shell/extensions/auto-theme-switcher-dev/\"|g" \
        "$BUILD_DIR/schemas/$DEV_SCHEMA.gschema.xml"

    echo ""
    echo "Build complete! Files in $BUILD_DIR:"
    ls -lh "$BUILD_DIR"/*.js "$BUILD_DIR"/*.json 2>/dev/null || true
    echo ""

    # Verify the modifications
    echo "Verification:"
    DEV_NAME=$(grep -Po '"name":\s*"\K[^"]+' "$BUILD_DIR/metadata.json")
    DEV_UUID_CHECK=$(grep -Po '"uuid":\s*"\K[^"]+' "$BUILD_DIR/metadata.json")
    DEV_SCHEMA_CHECK=$(grep -Po '"settings-schema":\s*"\K[^"]+' "$BUILD_DIR/metadata.json")
    echo "  Name: $DEV_NAME"
    echo "  UUID: $DEV_UUID_CHECK"
    echo "  Schema: $DEV_SCHEMA_CHECK"
    echo ""
}

package_extension() {
    echo "Creating dev package..."

    # Note: Do NOT compile schemas for GNOME 45+
    # The schema will be compiled automatically during installation

    # Create zip package in build directory
    cd "$BUILD_DIR"
    zip -q -r "$PACKAGE_NAME" ./* -x "$PACKAGE_NAME"
    cd ..

    echo ""
    echo "Dev package created: $PACKAGE_PATH"
    echo "File size: $(du -h "$PACKAGE_PATH" | cut -f1)"
    echo ""
    echo "To install locally:"
    echo "  gnome-extensions install $PACKAGE_PATH"
    echo ""
    echo "To enable after installation:"
    echo "  gnome-extensions enable $DEV_UUID"
    echo ""
}

# Main logic
if [ "$1" = "build" ]; then
    build_extension
else
    build_extension
    package_extension
fi
