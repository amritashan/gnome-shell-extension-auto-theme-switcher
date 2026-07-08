#!/bin/bash

# Build and package script for GNOME Shell extension
# Usage:
#   ./package.sh        - Build and create package
#   ./package.sh build  - Only build (copy files to build/)

set -e  # Exit on error

EXTENSION_UUID="auto-theme-switcher@amritashan.github.io"
SRC_DIR="src"
BUILD_DIR="build"
PACKAGE_NAME="${EXTENSION_UUID}.shell-extension.zip"
PACKAGE_PATH="$BUILD_DIR/$PACKAGE_NAME"

build_extension() {
    echo "Building GNOME Shell extension: $EXTENSION_UUID"

    # Clean previous build
    rm -rf "$BUILD_DIR"
    mkdir -p "$BUILD_DIR"

    # Copy ALL source files to build directory
    echo "Copying all files from $SRC_DIR/ to $BUILD_DIR/..."
    cp -rv "$SRC_DIR"/* "$BUILD_DIR/"

    # Remove compiled schemas (not needed for GNOME 45+, causes EGO rejection)
    rm -f "$BUILD_DIR/schemas/gschemas.compiled"

    # Remove tests — development-only, not part of the shipped extension
    rm -rf "$BUILD_DIR/tests"

    echo ""
    echo "Build complete! Files in $BUILD_DIR:"
    ls -lh "$BUILD_DIR"/*.js "$BUILD_DIR"/*.json 2>/dev/null || true
    echo ""
}

package_extension() {
    echo "Creating package..."

    # Note: Do NOT compile schemas for GNOME 45+
    # The schema will be compiled automatically during installation
    # Including gschemas.compiled will cause EGO review rejection

    # Create zip package in build directory
    cd "$BUILD_DIR"
    zip -q -r "$PACKAGE_NAME" ./* -x "$PACKAGE_NAME"
    cd ..

    echo ""
    echo "Package created: $PACKAGE_PATH"
    echo "File size: $(du -h "$PACKAGE_PATH" | cut -f1)"
    echo ""
    echo "To install locally:"
    echo "  gnome-extensions install $PACKAGE_PATH"
    echo ""
    echo "To submit to extensions.gnome.org:"
    echo "  1. Go to https://extensions.gnome.org/upload/"
    echo "  2. Upload $PACKAGE_PATH"
    echo "  3. Fill in the details and submit for review"
    echo ""
}

# Main logic
if [ "$1" = "build" ]; then
    build_extension
else
    build_extension
    package_extension
fi
