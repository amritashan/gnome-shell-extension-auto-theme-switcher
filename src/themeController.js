import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class ThemeController {
    constructor(settings) {
        this._settings = settings;
        this._interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
        this._colorSettings = new Gio.Settings({ schema_id: 'org.gnome.settings-daemon.plugins.color' });
    }

    switchTheme(isDark, showNotification = true, manualModeActive = false) {
        const theme = isDark ? this._settings.get_string('dark-theme') : this._settings.get_string('light-theme');
        const icon = isDark ? this._settings.get_string('dark-icon') : this._settings.get_string('light-icon');
        const trueLightMode = this._settings.get_boolean('true-light-mode');

        const currentTheme = this._interfaceSettings.get_string('gtk-theme');
        const currentIcon = this._interfaceSettings.get_string('icon-theme');
        const currentColorScheme = this._interfaceSettings.get_string('color-scheme');

        // Determine target color-scheme based on True Light Mode setting
        let colorScheme;
        let shouldChangeColorScheme = true;

        if (trueLightMode) {
            // True Light Mode enabled: change color-scheme fully (light apps + light shell)
            colorScheme = isDark ? 'prefer-dark' : 'prefer-light';
        } else {
            // True Light Mode disabled: use 'default' for light mode (light apps + dark shell)
            colorScheme = isDark ? 'prefer-dark' : 'default';
        }

        const themeAlreadySet = (currentTheme === theme && currentColorScheme === colorScheme);
        const iconAlreadySet = (currentIcon === icon)

        let shouldNotify = false;

        if (themeAlreadySet) {
            console.log(`ThemeSwitcher: Theme already set to ${isDark ? 'Dark' : 'Light'} (${theme}), no change needed`);
        }
        else {
          shouldNotify = true;
          this._interfaceSettings.set_string('gtk-theme', theme);
          this._interfaceSettings.set_string('color-scheme', colorScheme);

          const nightLightMode = this._settings.get_string('night-light-mode');
          if (nightLightMode === 'sync-with-theme') {
              this._colorSettings.set_boolean('night-light-enabled', isDark);
              console.log(`ThemeSwitcher: Night Light ${isDark ? 'enabled' : 'disabled'} (synced with theme)`);
          } else if (nightLightMode === 'custom-schedule') {
              this.updateNightLightSchedule();
          }

          console.log(`ThemeSwitcher: Switched to ${isDark ? 'Dark' : 'Light'} GTK theme (${theme}), color-scheme: ${colorScheme}, True Light Mode: ${trueLightMode ? 'enabled' : 'disabled'}`);
        }

        if (iconAlreadySet) {
            console.log(`ThemeSwitcher: Icon already set to ${isDark ? 'Dark' : 'Light'} (${icon}), no change needed`);
        }
        else {
          shouldNotify = true;
          this._interfaceSettings.set_string('icon-theme', icon);

          console.log(`ThemeSwitcher: Switched to ${isDark ? 'Dark' : 'Light'} Icon theme (${icon})`);
        }

        if (shouldNotify && showNotification && !manualModeActive && this._settings.get_boolean('show-notifications')) {
            const title = 'Auto Theme Switcher';
            const body = `Switched to ${isDark ? 'dark' : 'light'} mode`;
            const icon = isDark ? 'weather-clear-night-symbolic' : 'weather-clear-symbolic';

            Main.notify(title, body, icon);
        }
    }

    updateNightLightSchedule() {
        const startTime = this._settings.get_string('night-light-start-time');
        const endTime = this._settings.get_string('night-light-end-time');

        const [startH, startM] = startTime.split(':').map(Number);
        const [endH, endM] = endTime.split(':').map(Number);

        if (!isNaN(startH) && !isNaN(startM) && !isNaN(endH) && !isNaN(endM)) {
            const startFractional = startH + startM / 60;
            const endFractional = endH + endM / 60;

            this._colorSettings.set_boolean('night-light-enabled', true);
            this._colorSettings.set_boolean('night-light-schedule-automatic', false);
            this._colorSettings.set_double('night-light-schedule-from', startFractional);
            this._colorSettings.set_double('night-light-schedule-to', endFractional);

            console.log(`ThemeSwitcher: Night Light custom schedule set: ${startTime} to ${endTime}`);
        } else {
            console.error('ThemeSwitcher: Invalid Night Light schedule times');
        }
    }

    isCurrentlyInLightMode() {
        const currentColorScheme = this._interfaceSettings.get_string('color-scheme');
        return currentColorScheme !== 'prefer-dark';
    }

    initializeDefaultThemes() {
        const lightTheme = this._settings.get_string('light-theme');
        const darkTheme = this._settings.get_string('dark-theme');
        const currentTheme = this._interfaceSettings.get_string('gtk-theme');

        if (lightTheme === 'Adwaita' && darkTheme === 'Adwaita-dark') {
            this._settings.set_string('light-theme', currentTheme);
            this._settings.set_string('dark-theme', currentTheme);
        }
    }

    cleanup() {
        // Clear all GSettings references to prevent memory leaks
        this._settings = null;
        this._interfaceSettings = null;
        this._colorSettings = null;
    }
}
