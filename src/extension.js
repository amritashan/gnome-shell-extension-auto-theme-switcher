import Gio from 'gi://Gio';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import { ExtensionController } from './extensionController.js';

const ThemeSwitcherIface = `
<node>
    <interface name="org.gnome.Shell.Extensions.AutoThemeSwitcher">
        <method name="GetDebugInfo">
            <arg type="s" direction="out" name="info"/>
        </method>
        <method name="ForceThemeSwitch">
            <arg type="b" direction="in" name="isDark"/>
        </method>
        <method name="ResetToAutomatic"/>
    </interface>
</node>`;

// JUSTIFICATION FOR unlock-dialog SESSION MODE:
// This extension includes "unlock-dialog" in session-modes to remain active during screen lock.
// This is necessary to:
// 1. Detect unlock events via Main.sessionMode transitions (user <-> unlock-dialog)
// 2. Apply brightness adjustments ONLY when within a gradual transition window on unlock
// 3. Avoid adjusting brightness on every unlock (which would be disruptive)
// Without unlock-dialog mode, the extension would be disabled during lock and re-enabled
// on unlock, causing enable() to run and always adjust brightness (undesired behavior).
// This extension does NOT connect to any keyboard events in unlock-dialog mode.
export default class ThemeSwitcherExtension extends Extension {
    enable() {
        this._controller = new ExtensionController(this);
        this._controller.enable();

        // Export DBus interface
        this._dbus = Gio.DBusExportedObject.wrapJSObject(ThemeSwitcherIface, this);
        this._dbus.export(Gio.DBus.session, '/org/gnome/Shell/Extensions/AutoThemeSwitcher');
    }

    GetDebugInfo() {
        return this._controller.getDebugInfo();
    }

    ForceThemeSwitch(isDark) {
        this._controller.forceThemeSwitch(isDark);
    }

    ResetToAutomatic() {
        this._controller.resetToAutomatic();
    }

    disable() {
        // JUSTIFICATION FOR SESSION MODE CLEANUP:
        // This extension uses "unlock-dialog" session mode to remain active during screen lock.
        // We must properly disconnect from session mode signals and clean up all resources
        // to prevent memory leaks and ensure the extension can be cleanly re-enabled.

        if (this._controller) {
            this._controller.disable();
            this._controller = null;
        }

        if (this._dbus) {
            this._dbus.unexport();
            this._dbus = null;
        }
    }
}
