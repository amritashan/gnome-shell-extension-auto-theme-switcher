import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

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
        this._settings = this.getSettings();
        this._interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
        this._colorSettings = new Gio.Settings({ schema_id: 'org.gnome.settings-daemon.plugins.color' });
        this._timeoutId = null;
        this._debugInfo = null;
        this._manualModeActive = false;
        this._loginManager = null;

        // Export DBus interface
        this._dbus = Gio.DBusExportedObject.wrapJSObject(ThemeSwitcherIface, this);
        this._dbus.export(Gio.DBus.session, '/org/gnome/Shell/Extensions/AutoThemeSwitcher');

        // Listen for system suspend/resume events
        this._setupSuspendResumeHandler();

        // Run the main logic loop. It will reschedule itself.
        this._scheduleNextChangeEvent();
    }

    _setupSuspendResumeHandler() {
        try {
            // Connect to systemd-logind to detect suspend/resume
            this._suspendSignalId = Gio.DBus.system.signal_subscribe(
                'org.freedesktop.login1',
                'org.freedesktop.login1.Manager',
                'PrepareForSleep',
                '/org/freedesktop/login1',
                null,
                Gio.DBusSignalFlags.NONE,
                (connection, sender, path, iface, signal, params) => {
                    const [sleeping] = params.deep_unpack();
                    if (!sleeping) {
                        // System is resuming from suspend
                        console.log('ThemeSwitcher: System resumed from suspend, re-evaluating theme');
                        // Re-evaluate and reschedule after a short delay to ensure system is ready
                        GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
                            if (!this._manualModeActive) {
                                this._scheduleNextChangeEvent();
                            }
                            return GLib.SOURCE_REMOVE;
                        });
                    }
                }
            );
            console.log('ThemeSwitcher: Suspend/resume handler installed');
        } catch (e) {
            console.error(`ThemeSwitcher: Failed to setup suspend/resume handler: ${e}`);
        }
    }

    GetDebugInfo() {
        return JSON.stringify(this._debugInfo || {});
    }

    ForceThemeSwitch(isDark) {
        this._manualModeActive = true;
        this._switchTheme(isDark, false); // Don't show notification for manual switches
        console.log('ThemeSwitcher: Manual theme switch activated');
    }

    ResetToAutomatic() {
        this._manualModeActive = false;
        this._scheduleNextChangeEvent();
        console.log('ThemeSwitcher: Reset to automatic mode');
    }

    disable() {
        // Clean up when the extension is disabled
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }

        // Unsubscribe from suspend/resume signals
        if (this._suspendSignalId) {
            Gio.DBus.system.signal_unsubscribe(this._suspendSignalId);
            this._suspendSignalId = null;
        }

        // Unexport DBus interface
        if (this._dbus) {
            this._dbus.unexport();
            this._dbus = null;
        }

        this._settings = null;
        this._interfaceSettings = null;
        this._colorSettings = null;
    }

    async _getApiData() {
        try {
            const session = new Soup.Session();
            const locationMessage = Soup.Message.new('GET', 'https://ipinfo.io/loc');
            const locationBytes = await session.send_and_read_async(
                locationMessage,
                GLib.PRIORITY_DEFAULT,
                null
            );
            const location = new TextDecoder().decode(locationBytes.get_data()).trim();
            if (!location) return null;

            const [latitude, longitude] = location.split(',');

            // Store coordinates for debug display
            this._latitude = latitude;
            this._longitude = longitude;

            // Get sun times
            const url = `https://api.sunrisesunset.io/json?lat=${latitude}&lng=${longitude}`;
            const apiMessage = Soup.Message.new('GET', url);
            const apiBytes = await session.send_and_read_async(
                apiMessage,
                GLib.PRIORITY_DEFAULT,
                null
            );
            const apiData = JSON.parse(new TextDecoder().decode(apiBytes.get_data()));

            // Get location name using reverse geocoding (nominatim - free OSM service)
            try {
                const geoUrl = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=10`;
                const geoMessage = Soup.Message.new('GET', geoUrl);
                // Set User-Agent header (required by Nominatim)
                geoMessage.request_headers.append('User-Agent', 'GNOME-Auto-Theme-Switcher/1.0');
                const geoBytes = await session.send_and_read_async(
                    geoMessage,
                    GLib.PRIORITY_DEFAULT,
                    null
                );
                const geoData = JSON.parse(new TextDecoder().decode(geoBytes.get_data()));

                // Store location name
                if (geoData.address) {
                    const parts = [];
                    if (geoData.address.city) parts.push(geoData.address.city);
                    else if (geoData.address.town) parts.push(geoData.address.town);
                    else if (geoData.address.village) parts.push(geoData.address.village);

                    if (geoData.address.state) parts.push(geoData.address.state);
                    if (geoData.address.country) parts.push(geoData.address.country);

                    this._locationName = parts.join(', ') || 'Unknown';
                } else {
                    this._locationName = 'Unknown';
                }
            } catch (geoError) {
                console.error(`ThemeSwitcher: Failed to fetch location name: ${geoError}`);
                this._locationName = 'Unknown';
            }

            return apiData;
        } catch (e) {
            console.error(`ThemeSwitcher: Failed to fetch API data: ${e}`);
            return null;
        }
    }

    _parseTime(timeStr) {
        // Creates a Date object for a time string like "5:44:30 AM"
        const now = new Date();
        const [time, period] = timeStr.split(' ');
        let [hours, minutes, seconds] = time.split(':').map(Number);

        if (period === 'PM' && hours < 12) {
            hours += 12;
        }
        if (period === 'AM' && hours === 12) { // Midnight case
            hours = 0;
        }
        return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, seconds);
    }

    _switchTheme(isDark, showNotification = true) {
        const theme = isDark ? this._settings.get_string('dark-theme') : this._settings.get_string('light-theme');
        const colorScheme = isDark ? 'prefer-dark' : 'prefer-light';

        // Check if theme is already set to avoid unnecessary changes
        const currentTheme = this._interfaceSettings.get_string('gtk-theme');
        const currentColorScheme = this._interfaceSettings.get_string('color-scheme');

        const themeAlreadySet = (currentTheme === theme && currentColorScheme === colorScheme);

        if (themeAlreadySet) {
            console.log(`ThemeSwitcher: Theme already set to ${isDark ? 'Dark' : 'Light'} (${theme}), no change needed`);
            return; // Don't change anything or show notification
        }

        // Apply theme changes
        this._interfaceSettings.set_string('gtk-theme', theme);
        this._interfaceSettings.set_string('color-scheme', colorScheme);

        // Handle Night Light based on mode
        const nightLightMode = this._settings.get_string('night-light-mode');
        if (nightLightMode === 'sync-with-theme') {
            this._colorSettings.set_boolean('night-light-enabled', isDark);
            console.log(`ThemeSwitcher: Night Light ${isDark ? 'enabled' : 'disabled'} (synced with theme)`);
        } else if (nightLightMode === 'custom-schedule') {
            this._updateNightLightSchedule();
        }

        console.log(`ThemeSwitcher: Switched to ${isDark ? 'Dark' : 'Light'} theme (${theme}), Night Light mode: ${nightLightMode}`);

        // Show notification only if theme actually changed and notifications are enabled
        if (showNotification && !this._manualModeActive && this._settings.get_boolean('show-notifications')) {
            const title = 'Auto Theme Switcher';
            const body = `Switched to ${isDark ? 'dark' : 'light'} mode`;
            const icon = isDark ? 'weather-clear-night-symbolic' : 'weather-clear-symbolic';

            Main.notify(title, body, icon);
        }
    }

    _updateNightLightSchedule() {
        // Update Night Light schedule based on custom times
        const startTime = this._settings.get_string('night-light-start-time');
        const endTime = this._settings.get_string('night-light-end-time');

        // Parse times (HH:MM format)
        const [startH, startM] = startTime.split(':').map(Number);
        const [endH, endM] = endTime.split(':').map(Number);

        if (!isNaN(startH) && !isNaN(startM) && !isNaN(endH) && !isNaN(endM)) {
            // Convert to fractional hours (Night Light uses this format)
            const startFractional = startH + startM / 60;
            const endFractional = endH + endM / 60;

            // Enable Night Light and set schedule
            this._colorSettings.set_boolean('night-light-enabled', true);
            this._colorSettings.set_boolean('night-light-schedule-automatic', false);
            this._colorSettings.set_double('night-light-schedule-from', startFractional);
            this._colorSettings.set_double('night-light-schedule-to', endFractional);

            console.log(`ThemeSwitcher: Night Light custom schedule set: ${startTime} to ${endTime}`);
        } else {
            console.error('ThemeSwitcher: Invalid Night Light schedule times');
        }
    }

    async _scheduleNextChangeEvent() {
        // Clear any existing timeout
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }

        const apiData = await this._getApiData();
        if (!apiData || !apiData.results) {
            // If API fails, retry in 15 minutes
            console.log('ThemeSwitcher: API call failed, retrying in 15 minutes');
            this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 900, () => {
                this._scheduleNextChangeEvent();
                return GLib.SOURCE_REMOVE;
            });
            return;
        }

        const now = new Date();

        // Get light mode trigger time
        let lightTime;
        const lightModeTrigger = this._settings.get_string('light-mode-trigger');

        if (lightModeTrigger === 'first-light') {
            lightTime = this._parseTime(apiData.results.first_light);
        } else if (lightModeTrigger === 'dawn') {
            lightTime = this._parseTime(apiData.results.dawn);
        } else if (lightModeTrigger === 'sunrise') {
            lightTime = this._parseTime(apiData.results.sunrise);
        } else if (lightModeTrigger === 'custom') {
            const customTime = this._settings.get_string('custom-light-time');
            const timeParts = customTime.split(':');
            if (timeParts.length >= 2) {
                const h = parseInt(timeParts[0], 10);
                const m = parseInt(timeParts[1], 10);
                if (!isNaN(h) && !isNaN(m) && h >= 0 && h < 24 && m >= 0 && m < 60) {
                    lightTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0);
                } else {
                    console.error('ThemeSwitcher: Invalid custom light time format, falling back to sunrise');
                    lightTime = this._parseTime(apiData.results.sunrise);
                }
            } else {
                console.error('ThemeSwitcher: Invalid custom light time format, falling back to sunrise');
                lightTime = this._parseTime(apiData.results.sunrise);
            }
        } else { // Default to sunrise
            lightTime = this._parseTime(apiData.results.sunrise);
        }

        // Get dark mode trigger time
        let darkTime;
        const darkModeTrigger = this._settings.get_string('dark-mode-trigger');

        if (darkModeTrigger === 'golden-hour') {
            darkTime = this._parseTime(apiData.results.golden_hour);
        } else if (darkModeTrigger === 'dusk') {
            darkTime = this._parseTime(apiData.results.dusk);
        } else if (darkModeTrigger === 'last-light') {
            darkTime = this._parseTime(apiData.results.last_light);
        } else if (darkModeTrigger === 'custom') {
            const customTime = this._settings.get_string('custom-dark-time');
            const timeParts = customTime.split(':');
            if (timeParts.length >= 2) {
                const h = parseInt(timeParts[0], 10);
                const m = parseInt(timeParts[1], 10);
                if (!isNaN(h) && !isNaN(m) && h >= 0 && h < 24 && m >= 0 && m < 60) {
                    darkTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0);
                } else {
                    console.error('ThemeSwitcher: Invalid custom dark time format, falling back to golden hour');
                    darkTime = this._parseTime(apiData.results.golden_hour);
                }
            } else {
                console.error('ThemeSwitcher: Invalid custom dark time format, falling back to golden hour');
                darkTime = this._parseTime(apiData.results.golden_hour);
            }
        } else { // Default to golden-hour
            darkTime = this._parseTime(apiData.results.golden_hour);
        }

        // Store current state for debug panel
        this._debugInfo = {
            apiData: apiData.results,
            currentTime: now.toLocaleString(),
            lightTime: lightTime.toLocaleString(),
            darkTime: darkTime.toLocaleString(),
            lightModeTrigger: lightModeTrigger,
            darkModeTrigger: darkModeTrigger,
            currentMode: '',
            nextEventTime: '',
            secondsToNextEvent: 0,
            nextEventType: '',
            latitude: this._latitude || 'N/A',
            longitude: this._longitude || 'N/A',
            locationName: this._locationName || 'Unknown',
        };

        let nextEventTime, switchToDark;
        if (now >= darkTime || now < lightTime) {
            // It's currently night. Set dark theme. Next event is light mode switch.
            this._switchTheme(true);
            switchToDark = false;
            // If light time hasn't happened yet today, use today's light time; otherwise tomorrow's
            if (now < lightTime) {
                nextEventTime = lightTime;
            } else {
                // Get tomorrow's light time by adding 24 hours
                nextEventTime = new Date(lightTime.getTime() + 24 * 60 * 60 * 1000);
            }
            this._debugInfo.currentMode = 'night';
        } else {
            // It's currently day. Set light theme. Next event is dark time.
            this._switchTheme(false);
            switchToDark = true;
            nextEventTime = darkTime;
            this._debugInfo.currentMode = 'day';
        }

        const secondsToNextEvent = Math.round((nextEventTime.getTime() - now.getTime()) / 1000);

        this._debugInfo.nextEventTime = nextEventTime.toLocaleString();
        this._debugInfo.secondsToNextEvent = secondsToNextEvent;
        this._debugInfo.nextEventType = switchToDark ? 'dark' : 'light';

        console.log(`ThemeSwitcher: Current mode: ${this._debugInfo.currentMode}, Next switch to ${this._debugInfo.nextEventType} in ${secondsToNextEvent} seconds (${nextEventTime.toLocaleString()})`);

        // Schedule the timeout
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, secondsToNextEvent, () => {
            this._switchTheme(switchToDark);
            this._scheduleNextChangeEvent(); // Reschedule for the next event in the chain
            return GLib.SOURCE_REMOVE; // Important: remove the old timer
        });
    }
}
