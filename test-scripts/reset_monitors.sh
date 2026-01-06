#!/bin/bash

# Script to reset the monitors list for testing fresh migration

SCHEMA="org.gnome.shell.extensions.auto-theme-switcher"

echo "Current monitors setting:"
gsettings get $SCHEMA monitors
echo ""

echo "Resetting monitors list..."
gsettings reset $SCHEMA monitors

echo "Resetting last detection timestamp..."
gsettings reset $SCHEMA monitors-last-detection

echo ""
echo "Settings reset! Monitors list is now:"
gsettings get $SCHEMA monitors

echo ""
echo "To test fresh migration, restart GNOME Shell:"
echo "  X11: Press Alt+F2, type 'r', press Enter"
echo "  Wayland: Log out and log back in"
