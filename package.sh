#!/bin/bash

# Package script for GNOME Shell extension

EXTENSION_UUID="auto-theme-switcher@amritashan.github.io"
SRC_DIR="src"
BUILD_DIR="build"
PACKAGE_NAME="${EXTENSION_UUID}.shell-extension.zip"
PACKAGE_PATH="$BUILD_DIR/$PACKAGE_NAME"

echo "Packaging GNOME Shell extension: $EXTENSION_UUID"

# Clean previous build
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# Copy source files to build directory
echo "Copying files to build directory..."
cp -r "$SRC_DIR"/* "$BUILD_DIR/"

# Note: Do NOT compile schemas for GNOME 45+
# The schema will be compiled automatically during installation
# Including gschemas.compiled will cause EGO review rejection

# Create zip package in build directory
echo "Creating package..."
cd "$BUILD_DIR"
zip -r "$PACKAGE_NAME" ./* -x "$PACKAGE_NAME"

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
