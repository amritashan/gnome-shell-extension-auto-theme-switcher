import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class ThemeSwitcherPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        // Get the settings schema for this extension
        this.settings = this.getSettings();

        // Create a preferences page and group
        const page = new Adw.PreferencesPage({
            title: 'Settings',
            icon_name: 'preferences-system-symbolic',
        });
        const group = new Adw.PreferencesGroup({ title: 'Theme Settings' });
        page.add(group);

        // --- Light Theme Dropdown ---
        const lightThemeRow = new Adw.ComboRow({
            title: 'Light Theme',
            subtitle: 'Theme to use during the day',
        });
        const lightThemeModel = new Gtk.StringList();
        // A simple way to get themes. A more robust method would be needed for production.
        const themes = Gio.File.new_for_path('/usr/share/themes').enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = themes.next_file(null))) {
            lightThemeModel.append(info.get_name());
        }
        lightThemeRow.model = lightThemeModel;
        group.add(lightThemeRow);

        // --- Dark Theme Dropdown ---
        const darkThemeRow = new Adw.ComboRow({
            title: 'Dark Theme',
            subtitle: 'Theme to use at night',
        });
        const darkThemeModel = new Gtk.StringList();
        const themes2 = Gio.File.new_for_path('/usr/share/themes').enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        while ((info = themes2.next_file(null))) {
            darkThemeModel.append(info.get_name());
        }
        darkThemeRow.model = darkThemeModel;
        group.add(darkThemeRow);

        // --- Night Light Options ---
        const nightLightGroup = new Adw.PreferencesGroup({ title: 'Night Light Control' });
        page.add(nightLightGroup);

        const nightLightModeRow = new Adw.ComboRow({
            title: 'Night Light Mode',
        });
        const nightLightModel = new Gtk.StringList();
        nightLightModel.append('Disabled');
        nightLightModel.append('Sync with Theme');
        nightLightModel.append('Custom Schedule');
        nightLightModeRow.model = nightLightModel;
        nightLightGroup.add(nightLightModeRow);

        const nightLightMap = { 0: 'disabled', 1: 'sync-with-theme', 2: 'custom-schedule' };
        const savedNightLightMode = this.settings.get_string('night-light-mode');
        const nightLightIndex = Object.keys(nightLightMap).find(key => nightLightMap[key] === savedNightLightMode) || 0;
        nightLightModeRow.selected = nightLightIndex;

        // --- Night Light Custom Schedule Times ---
        const nightLightStartRow = new Adw.ActionRow({
            title: 'Night Light Start Time (24-hour)',
        });
        const nightLightStartEntry = new Gtk.Entry({
            text: this.settings.get_string('night-light-start-time'),
            valign: Gtk.Align.CENTER,
        });
        nightLightStartRow.add_suffix(nightLightStartEntry);
        nightLightGroup.add(nightLightStartRow);

        const nightLightEndRow = new Adw.ActionRow({
            title: 'Night Light End Time (24-hour)',
        });
        const nightLightEndEntry = new Gtk.Entry({
            text: this.settings.get_string('night-light-end-time'),
            valign: Gtk.Align.CENTER,
        });
        nightLightEndRow.add_suffix(nightLightEndEntry);
        nightLightGroup.add(nightLightEndRow);

        // Show/hide Night Light schedule times based on mode
        nightLightStartRow.visible = nightLightModeRow.selected === 2;
        nightLightEndRow.visible = nightLightModeRow.selected === 2;
        nightLightModeRow.connect('notify::selected', () => {
            nightLightStartRow.visible = nightLightModeRow.selected === 2;
            nightLightEndRow.visible = nightLightModeRow.selected === 2;
        });

        // --- Notifications Toggle ---
        const notificationsRow = new Adw.ActionRow({
            title: 'Show Notifications',
            subtitle: 'Display a notification when theme switches automatically',
        });
        const notificationsToggle = new Gtk.Switch({
            active: this.settings.get_boolean('show-notifications'),
            valign: Gtk.Align.CENTER,
        });
        notificationsRow.add_suffix(notificationsToggle);
        notificationsRow.activatable_widget = notificationsToggle;
        group.add(notificationsRow);

        // --- Light Mode Trigger Settings ---
        const lightTriggerGroup = new Adw.PreferencesGroup({ title: 'Light Mode Trigger' });
        page.add(lightTriggerGroup);

        const lightTriggerRow = new Adw.ComboRow({
            title: 'Switch to Light Mode at...',
        });
        const lightTriggerModel = new Gtk.StringList();
        lightTriggerModel.append('First Light');
        lightTriggerModel.append('Dawn');
        lightTriggerModel.append('Sunrise');
        lightTriggerModel.append('Specific Time');
        lightTriggerRow.model = lightTriggerModel;
        lightTriggerGroup.add(lightTriggerRow);

        const lightTriggerMap = { 0: 'first-light', 1: 'dawn', 2: 'sunrise', 3: 'custom' };
        const savedLightTrigger = this.settings.get_string('light-mode-trigger');
        const lightTriggerIndex = Object.keys(lightTriggerMap).find(key => lightTriggerMap[key] === savedLightTrigger) || 2;
        lightTriggerRow.selected = lightTriggerIndex;

        // --- Specific Light Time Entry ---
        const customLightTimeRow = new Adw.ActionRow({
            title: 'Specific Light Time (24-hour)',
        });
        const customLightTimeEntry = new Gtk.Entry({
            text: this.settings.get_string('custom-light-time'),
            valign: Gtk.Align.CENTER,
        });
        customLightTimeRow.add_suffix(customLightTimeEntry);
        lightTriggerGroup.add(customLightTimeRow);

        // Show/hide specific light time row based on trigger selection
        customLightTimeRow.visible = lightTriggerRow.selected === 3;
        lightTriggerRow.connect('notify::selected', () => {
            customLightTimeRow.visible = lightTriggerRow.selected === 3;
        });

        // --- Dark Mode Trigger Settings ---
        const darkTriggerGroup = new Adw.PreferencesGroup({ title: 'Dark Mode Trigger' });
        page.add(darkTriggerGroup);

        const darkTriggerRow = new Adw.ComboRow({
            title: 'Switch to Dark Mode at...',
        });
        const darkTriggerModel = new Gtk.StringList();
        darkTriggerModel.append('Golden Hour');
        darkTriggerModel.append('Dusk');
        darkTriggerModel.append('Last Light');
        darkTriggerModel.append('Specific Time');
        darkTriggerRow.model = darkTriggerModel;
        darkTriggerGroup.add(darkTriggerRow);

        const darkTriggerMap = { 0: 'golden-hour', 1: 'dusk', 2: 'last-light', 3: 'custom' };
        const savedDarkTrigger = this.settings.get_string('dark-mode-trigger');
        const darkTriggerIndex = Object.keys(darkTriggerMap).find(key => darkTriggerMap[key] === savedDarkTrigger) || 0;
        darkTriggerRow.selected = darkTriggerIndex;

        // --- Specific Dark Time Entry ---
        const customDarkTimeRow = new Adw.ActionRow({
            title: 'Specific Dark Time (24-hour)',
        });
        const customDarkTimeEntry = new Gtk.Entry({
            text: this.settings.get_string('custom-dark-time'),
            valign: Gtk.Align.CENTER,
        });
        customDarkTimeRow.add_suffix(customDarkTimeEntry);
        darkTriggerGroup.add(customDarkTimeRow);

        // Show/hide specific dark time row based on trigger selection
        customDarkTimeRow.visible = darkTriggerRow.selected === 3;
        darkTriggerRow.connect('notify::selected', () => {
            customDarkTimeRow.visible = darkTriggerRow.selected === 3;
        });

        // --- Bind settings to UI widgets ---
        // Load saved theme selections
        const savedLightTheme = this.settings.get_string('light-theme');
        const savedDarkTheme = this.settings.get_string('dark-theme');

        // Find and set the selected index for light theme
        for (let i = 0; i < lightThemeModel.get_n_items(); i++) {
            if (lightThemeModel.get_string(i) === savedLightTheme) {
                lightThemeRow.selected = i;
                break;
            }
        }

        // Find and set the selected index for dark theme
        for (let i = 0; i < darkThemeModel.get_n_items(); i++) {
            if (darkThemeModel.get_string(i) === savedDarkTheme) {
                darkThemeRow.selected = i;
                break;
            }
        }

        // Connect to save changes
        lightThemeRow.connect('notify::selected', () => {
            const selected = lightThemeRow.selected_item;
            if (selected) {
                this.settings.set_string('light-theme', selected.string);
            }
        });

        darkThemeRow.connect('notify::selected', () => {
            const selected = darkThemeRow.selected_item;
            if (selected) {
                this.settings.set_string('dark-theme', selected.string);
            }
        });

        this.settings.bind('show-notifications', notificationsToggle, 'active', Gio.SettingsBindFlags.DEFAULT);
        this.settings.bind('custom-light-time', customLightTimeEntry, 'text', Gio.SettingsBindFlags.DEFAULT);
        this.settings.bind('custom-dark-time', customDarkTimeEntry, 'text', Gio.SettingsBindFlags.DEFAULT);
        this.settings.bind('night-light-start-time', nightLightStartEntry, 'text', Gio.SettingsBindFlags.DEFAULT);
        this.settings.bind('night-light-end-time', nightLightEndEntry, 'text', Gio.SettingsBindFlags.DEFAULT);

        lightTriggerRow.connect('notify::selected', () => {
            this.settings.set_string('light-mode-trigger', lightTriggerMap[lightTriggerRow.selected]);
        });

        darkTriggerRow.connect('notify::selected', () => {
            this.settings.set_string('dark-mode-trigger', darkTriggerMap[darkTriggerRow.selected]);
        });

        nightLightModeRow.connect('notify::selected', () => {
            this.settings.set_string('night-light-mode', nightLightMap[nightLightModeRow.selected]);
        });

        // Add the settings page to the window
        window.add(page);

        // --- Debug Panel Page ---
        const debugPage = new Adw.PreferencesPage({
            title: 'Debug',
            icon_name: 'dialog-information-symbolic',
        });

        const debugGroup = new Adw.PreferencesGroup({ title: 'Debug Information' });
        debugPage.add(debugGroup);

        // Info display rows
        const currentModeRow = new Adw.ActionRow({ title: 'Current Mode' });
        const currentModeLabel = new Gtk.Label({ label: 'N/A' });
        currentModeRow.add_suffix(currentModeLabel);
        debugGroup.add(currentModeRow);

        const currentTimeRow = new Adw.ActionRow({ title: 'Current Time' });
        const currentTimeLabel = new Gtk.Label({ label: 'N/A' });
        currentTimeRow.add_suffix(currentTimeLabel);
        debugGroup.add(currentTimeRow);

        const lightTimeRow = new Adw.ActionRow({ title: 'Light Mode Switch Time' });
        const lightTimeLabel = new Gtk.Label({ label: 'N/A' });
        lightTimeRow.add_suffix(lightTimeLabel);
        debugGroup.add(lightTimeRow);

        const darkTimeRow = new Adw.ActionRow({ title: 'Dark Mode Switch Time' });
        const darkTimeLabel = new Gtk.Label({ label: 'N/A' });
        darkTimeRow.add_suffix(darkTimeLabel);
        debugGroup.add(darkTimeRow);

        const nextEventRow = new Adw.ActionRow({ title: 'Next Switch At' });
        const nextEventLabel = new Gtk.Label({ label: 'N/A' });
        nextEventRow.add_suffix(nextEventLabel);
        debugGroup.add(nextEventRow);

        const nextEventTypeRow = new Adw.ActionRow({ title: 'Next Switch Type' });
        const nextEventTypeLabel = new Gtk.Label({ label: 'N/A' });
        nextEventTypeRow.add_suffix(nextEventTypeLabel);
        debugGroup.add(nextEventTypeRow);

        const timeToNextRow = new Adw.ActionRow({ title: 'Time to Next Switch' });
        const timeToNextLabel = new Gtk.Label({ label: 'N/A' });
        timeToNextRow.add_suffix(timeToNextLabel);
        debugGroup.add(timeToNextRow);

        // Location info from API
        const locationGroup = new Adw.PreferencesGroup({ title: 'Location Information' });
        debugPage.add(locationGroup);

        const locationNameRow = new Adw.ActionRow({ title: 'Detected Location' });
        const locationNameLabel = new Gtk.Label({ label: 'N/A' });
        locationNameRow.add_suffix(locationNameLabel);
        locationGroup.add(locationNameRow);

        const coordinatesRow = new Adw.ActionRow({ title: 'Coordinates' });
        const coordinatesLabel = new Gtk.Label({ label: 'N/A' });
        coordinatesRow.add_suffix(coordinatesLabel);
        locationGroup.add(coordinatesRow);

        const timezoneRow = new Adw.ActionRow({ title: 'Timezone' });
        const timezoneLabel = new Gtk.Label({ label: 'N/A' });
        timezoneRow.add_suffix(timezoneLabel);
        locationGroup.add(timezoneRow);

        // Test controls
        const testGroup = new Adw.PreferencesGroup({ title: 'Manual Testing' });
        debugPage.add(testGroup);

        const darkTestRow = new Adw.ActionRow({
            title: 'Preview Dark Theme',
            subtitle: 'Switch to dark theme for testing',
        });
        const darkTestButton = new Gtk.Button({
            label: 'Apply Dark',
            valign: Gtk.Align.CENTER,
        });
        darkTestButton.connect('clicked', () => {
            this._callExtensionMethod('forceThemeSwitch', [true]);
        });
        darkTestRow.add_suffix(darkTestButton);
        testGroup.add(darkTestRow);

        const lightTestRow = new Adw.ActionRow({
            title: 'Preview Light Theme',
            subtitle: 'Switch to light theme for testing',
        });
        const lightTestButton = new Gtk.Button({
            label: 'Apply Light',
            valign: Gtk.Align.CENTER,
        });
        lightTestButton.connect('clicked', () => {
            this._callExtensionMethod('forceThemeSwitch', [false]);
        });
        lightTestRow.add_suffix(lightTestButton);
        testGroup.add(lightTestRow);

        const resetRow = new Adw.ActionRow({
            title: 'Reset to Automatic',
            subtitle: 'Return to automatic theme switching',
        });
        const resetButton = new Gtk.Button({
            label: 'Reset',
            valign: Gtk.Align.CENTER,
        });
        resetButton.add_css_class('suggested-action');
        resetButton.connect('clicked', () => {
            this._callExtensionMethod('resetToAutomatic', []);
        });
        resetRow.add_suffix(resetButton);
        testGroup.add(resetRow);

        const refreshRow = new Adw.ActionRow({
            title: 'Refresh Debug Info',
            subtitle: 'Update debug information display',
        });
        const refreshButton = new Gtk.Button({
            label: 'Refresh',
            valign: Gtk.Align.CENTER,
        });
        refreshButton.connect('clicked', () => {
            this._updateDebugInfo();
        });
        refreshRow.add_suffix(refreshButton);
        testGroup.add(refreshRow);

        // Add debug page to window
        window.add(debugPage);

        // Store labels for updating
        this._debugLabels = {
            currentMode: currentModeLabel,
            currentTime: currentTimeLabel,
            lightTime: lightTimeLabel,
            darkTime: darkTimeLabel,
            nextEvent: nextEventLabel,
            nextEventType: nextEventTypeLabel,
            timeToNext: timeToNextLabel,
            locationName: locationNameLabel,
            coordinates: coordinatesLabel,
            timezone: timezoneLabel,
        };

        // Store the next event time for countdown calculation
        this._nextEventTimestamp = null;

        // Update current time and countdown every second
        this._timeUpdateId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            // Update current time
            const now = new Date();
            currentTimeLabel.set_label(now.toLocaleString());

            // Update countdown if we have a next event time
            if (this._nextEventTimestamp) {
                const secondsRemaining = Math.max(0, Math.round((this._nextEventTimestamp - now.getTime()) / 1000));
                const hours = Math.floor(secondsRemaining / 3600);
                const minutes = Math.floor((secondsRemaining % 3600) / 60);
                const seconds = secondsRemaining % 60;
                timeToNextLabel.set_label(`${hours}h ${minutes}m ${seconds}s`);
            }

            return GLib.SOURCE_CONTINUE;
        });

        // Auto-refresh full debug info every 5 seconds
        this._debugRefreshId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
            this._updateDebugInfo();
            return GLib.SOURCE_CONTINUE;
        });

        // Initial update
        this._updateDebugInfo();

        // Clean up timers when window closes
        window.connect('close-request', () => {
            if (this._timeUpdateId) {
                GLib.source_remove(this._timeUpdateId);
                this._timeUpdateId = null;
            }
            if (this._debugRefreshId) {
                GLib.source_remove(this._debugRefreshId);
                this._debugRefreshId = null;
            }
            return false;
        });
    }

    _updateDebugInfo() {
        try {
            const debugInfo = this._getExtensionDebugInfo();
            if (debugInfo && this._debugLabels) {
                this._debugLabels.currentMode.set_label(debugInfo.currentMode || 'N/A');
                this._debugLabels.currentTime.set_label(debugInfo.currentTime || 'N/A');
                this._debugLabels.lightTime.set_label(debugInfo.lightTime || 'N/A');
                this._debugLabels.darkTime.set_label(debugInfo.darkTime || 'N/A');
                this._debugLabels.nextEvent.set_label(debugInfo.nextEventTime || 'N/A');
                this._debugLabels.nextEventType.set_label(debugInfo.nextEventType || 'N/A');

                // Store the timestamp for countdown calculation
                if (debugInfo.secondsToNextEvent) {
                    // Calculate the timestamp based on current time + seconds remaining
                    const now = new Date();
                    this._nextEventTimestamp = now.getTime() + (debugInfo.secondsToNextEvent * 1000);
                }

                // Initial countdown display (will be updated every second)
                const seconds = debugInfo.secondsToNextEvent || 0;
                const hours = Math.floor(seconds / 3600);
                const minutes = Math.floor((seconds % 3600) / 60);
                const secs = seconds % 60;
                this._debugLabels.timeToNext.set_label(`${hours}h ${minutes}m ${secs}s`);

                // Location information
                this._debugLabels.locationName.set_label(debugInfo.locationName || 'Unknown');

                if (debugInfo.latitude && debugInfo.longitude) {
                    this._debugLabels.coordinates.set_label(`${debugInfo.latitude}, ${debugInfo.longitude}`);
                }

                if (debugInfo.apiData && debugInfo.apiData.timezone) {
                    this._debugLabels.timezone.set_label(debugInfo.apiData.timezone);
                }
            }
        } catch (e) {
            console.error(`Failed to update debug info: ${e}`);
        }
    }

    _getExtensionDebugInfo() {
        try {
            const result = Gio.DBus.session.call_sync(
                'org.gnome.Shell',
                '/org/gnome/Shell/Extensions/AutoThemeSwitcher',
                'org.gnome.Shell.Extensions.AutoThemeSwitcher',
                'GetDebugInfo',
                null,
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null
            );
            const [jsonString] = result.deep_unpack();
            return JSON.parse(jsonString);
        } catch (e) {
            console.error(`Failed to get debug info: ${e}`);
            return null;
        }
    }

    _callExtensionMethod(method, args) {
        try {
            if (method === 'forceThemeSwitch') {
                Gio.DBus.session.call_sync(
                    'org.gnome.Shell',
                    '/org/gnome/Shell/Extensions/AutoThemeSwitcher',
                    'org.gnome.Shell.Extensions.AutoThemeSwitcher',
                    'ForceThemeSwitch',
                    new GLib.Variant('(b)', args),
                    null,
                    Gio.DBusCallFlags.NONE,
                    -1,
                    null
                );
            } else if (method === 'resetToAutomatic') {
                Gio.DBus.session.call_sync(
                    'org.gnome.Shell',
                    '/org/gnome/Shell/Extensions/AutoThemeSwitcher',
                    'org.gnome.Shell.Extensions.AutoThemeSwitcher',
                    'ResetToAutomatic',
                    null,
                    null,
                    Gio.DBusCallFlags.NONE,
                    -1,
                    null
                );
            }
        } catch (e) {
            console.error(`Failed to call extension method ${method}: ${e}`);
        }
    }
}

