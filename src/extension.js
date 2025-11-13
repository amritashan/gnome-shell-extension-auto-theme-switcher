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
