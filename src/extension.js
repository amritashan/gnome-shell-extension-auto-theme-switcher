import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {
    BRIGHTNESS_UPDATE_INTERVAL_SECONDS,
    API_REFRESH_INTERVAL_SECONDS,
    RESUME_DELAY_SECONDS,
    MS_PER_SECOND,
    MS_PER_DAY
} from './constants.js';

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
        this._brightnessTimeoutId = null;
        this._lastBrightnessUpdateTime = null;
        this._debugInfo = null;
        this._manualModeActive = false;
        this._loginManager = null;
        this._lightTime = null;
        this._darkTime = null;
        this._sessionModeSignalId = null;
        this._screenSaverProxy = null;
        this._screenSaverSignalId = null;

        // Initialize default themes from current system theme on first run
        this._initializeDefaultThemes();

        // Export DBus interface
        this._dbus = Gio.DBusExportedObject.wrapJSObject(ThemeSwitcherIface, this);
        this._dbus.export(Gio.DBus.session, '/org/gnome/Shell/Extensions/AutoThemeSwitcher');

        // Setup lock/unlock detection with multiple fallback methods
        this._setupLockUnlockDetection();

        // Listen for system suspend/resume events
        this._setupSuspendResumeHandler();

        // Listen for settings changes that require re-scheduling
        this._autoDetectChangedId = this._settings.connect('changed::auto-detect-location', () => {
            if (!this._manualModeActive) {
                this._scheduleNextChangeEvent();
            }
        });

        this._lightTriggerChangedId = this._settings.connect('changed::light-mode-trigger', () => {
            if (!this._manualModeActive) {
                this._scheduleNextChangeEvent();
            }
        });

        this._darkTriggerChangedId = this._settings.connect('changed::dark-mode-trigger', () => {
            if (!this._manualModeActive) {
                this._scheduleNextChangeEvent();
            }
        });

        this._customLightTimeChangedId = this._settings.connect('changed::custom-light-time', () => {
            if (!this._manualModeActive) {
                this._scheduleNextChangeEvent();
            }
        });

        this._customDarkTimeChangedId = this._settings.connect('changed::custom-dark-time', () => {
            if (!this._manualModeActive) {
                this._scheduleNextChangeEvent();
            }
        });

        this._useManualCoordsChangedId = this._settings.connect('changed::use-manual-coordinates', () => {
            if (!this._manualModeActive) {
                this._scheduleNextChangeEvent();
            }
        });

        this._manualLatitudeChangedId = this._settings.connect('changed::manual-latitude', () => {
            if (!this._manualModeActive) {
                this._scheduleNextChangeEvent();
            }
        });

        this._manualLongitudeChangedId = this._settings.connect('changed::manual-longitude', () => {
            if (!this._manualModeActive) {
                this._scheduleNextChangeEvent();
            }
        });

        // Listen for brightness control setting changes
        this._controlBrightnessChangedId = this._settings.connect('changed::control-brightness', () => {
            this._scheduleBrightnessUpdates();
        });

        this._lightBrightnessChangedId = this._settings.connect('changed::light-brightness', () => {
            this._updateBrightness();
        });

        this._darkBrightnessChangedId = this._settings.connect('changed::dark-brightness', () => {
            this._updateBrightness();
        });

        // Run the main logic loop. It will reschedule itself.
        // Since enable() only runs on login (not unlock), always set brightness immediately
        // Note: _scheduleNextChangeEvent() will call _scheduleBrightnessUpdates() after setting times
        this._scheduleNextChangeEvent(true);
    }

    _setupLockUnlockDetection() {
        // Setup multiple methods for detecting lock/unlock for cross-version compatibility
        //
        // JUSTIFICATION FOR unlock-dialog SESSION MODE:
        // This extension includes "unlock-dialog" in session-modes to remain active during screen lock.
        // This is necessary to:
        // 1. Detect unlock events via Main.sessionMode transitions (user <-> unlock-dialog)
        // 2. Apply brightness adjustments ONLY when within a gradual transition window on unlock
        // 3. Avoid adjusting brightness on every unlock (which would be disruptive)
        // Without unlock-dialog mode, the extension would be disabled during lock and re-enabled
        // on unlock, causing enable() to run and always adjust brightness (undesired behavior).
        // This extension does NOT connect to any keyboard events in unlock-dialog mode.
        //
        // Method 1: Main.sessionMode (official GNOME 45+ approach)
        this._setupSessionModeHandler();

        // Method 2: ScreenSaver D-Bus (fallback for older versions or systems where sessionMode doesn't work)
        this._setupScreenSaverHandler();
    }

    _setupSessionModeHandler() {
        try {
            // Listen for session mode changes (user <-> unlock-dialog)
            // This is the official GNOME 45+ approach for detecting lock/unlock
            this._sessionModeSignalId = Main.sessionMode.connect('updated', () => {
                const currentMode = Main.sessionMode.currentMode;
                const parentMode = Main.sessionMode.parentMode;

                // Check if we're transitioning back to user mode (unlock)
                if (currentMode === 'user' || parentMode === 'user') {
                    // On unlock, only adjust brightness if we're in an adjustment window
                    this._updateBrightness(false);
                }
            });
        } catch (e) {
            console.error(`ThemeSwitcher: Failed to setup session mode handler: ${e}`);
        }
    }

    async _setupScreenSaverHandler() {
        try {
            // Listen for screen lock/unlock events via D-Bus (fallback method)
            // Use async to avoid freezing the shell
            this._screenSaverProxy = await Gio.DBusProxy.new(
                Gio.DBus.session,
                Gio.DBusProxyFlags.NONE,
                null,
                'org.gnome.ScreenSaver',
                '/org/gnome/ScreenSaver',
                'org.gnome.ScreenSaver',
                null
            );

            // Connect to ActiveChanged signal
            // true = locked, false = unlocked
            this._screenSaverSignalId = this._screenSaverProxy.connectSignal('ActiveChanged', (_proxy, _sender, [isActive]) => {
                if (!isActive) {
                    // On unlock, only adjust brightness if we're in an adjustment window
                    this._updateBrightness(false);
                }
            });
        } catch (e) {
            console.error(`ThemeSwitcher: Failed to setup ScreenSaver handler: ${e}`);
        }
    }

    _initializeDefaultThemes() {
        // On first run, if themes are still set to defaults (Adwaita/Adwaita-dark),
        // set both to the current system theme so user only needs to change one
        const lightTheme = this._settings.get_string('light-theme');
        const darkTheme = this._settings.get_string('dark-theme');
        const currentTheme = this._interfaceSettings.get_string('gtk-theme');

        // Check if both are still at default values
        if (lightTheme === 'Adwaita' && darkTheme === 'Adwaita-dark') {
            this._settings.set_string('light-theme', currentTheme);
            this._settings.set_string('dark-theme', currentTheme);
        }
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
                        // Clear any existing resume timeout
                        if (this._resumeTimeoutId) {
                            GLib.source_remove(this._resumeTimeoutId);
                            this._resumeTimeoutId = null;
                        }
                        // Re-evaluate and reschedule after a short delay to ensure system is ready
                        this._resumeTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, RESUME_DELAY_SECONDS, async () => {
                            if (!this._manualModeActive) {
                                await this._scheduleNextChangeEvent();
                            }
                            this._resumeTimeoutId = null;
                            return GLib.SOURCE_REMOVE;
                        });
                    }
                }
            );
        } catch (e) {
            console.error(`ThemeSwitcher: Failed to setup suspend/resume handler: ${e}`);
        }
    }

    GetDebugInfo() {
        // Always refresh debug info before returning it
        const now = new Date();
        const lightTrigger = this._settings.get_string('light-mode-trigger');
        const darkTrigger = this._settings.get_string('dark-mode-trigger');

        this._storeDebugInfo(now, this._lightTime, this._darkTime, lightTrigger, darkTrigger, null);
        return JSON.stringify(this._debugInfo || {});
    }

    ForceThemeSwitch(isDark) {
        this._manualModeActive = true;
        this._switchTheme(isDark, false); // Don't show notification for manual switches
    }

    ResetToAutomatic() {
        this._manualModeActive = false;
        this._scheduleNextChangeEvent();
    }

    disable() {
        // Clean up when the extension is disabled
        // Use try-catch blocks to ensure all cleanup happens even if individual steps fail

        // Clean up timers
        try {
            if (this._timeoutId) {
                GLib.source_remove(this._timeoutId);
                this._timeoutId = null;
            }
        } catch (e) {
            console.error(`ThemeSwitcher: Error removing main timeout: ${e}`);
        }

        try {
            if (this._brightnessTimeoutId) {
                GLib.source_remove(this._brightnessTimeoutId);
                this._brightnessTimeoutId = null;
            }
        } catch (e) {
            console.error(`ThemeSwitcher: Error removing brightness timeout: ${e}`);
        }

        try {
            if (this._resumeTimeoutId) {
                GLib.source_remove(this._resumeTimeoutId);
                this._resumeTimeoutId = null;
            }
        } catch (e) {
            console.error(`ThemeSwitcher: Error removing resume timeout: ${e}`);
        }

        // Disconnect session mode signal
        try {
            if (this._sessionModeSignalId) {
                Main.sessionMode.disconnect(this._sessionModeSignalId);
                this._sessionModeSignalId = null;
            }
        } catch (e) {
            console.error(`ThemeSwitcher: Error disconnecting session mode signal: ${e}`);
            this._sessionModeSignalId = null;
        }

        // Disconnect ScreenSaver D-Bus signal
        try {
            if (this._screenSaverProxy && this._screenSaverSignalId) {
                this._screenSaverProxy.disconnectSignal(this._screenSaverSignalId);
                this._screenSaverSignalId = null;
            }
        } catch (e) {
            console.error(`ThemeSwitcher: Error disconnecting ScreenSaver signal: ${e}`);
            this._screenSaverSignalId = null;
        }

        // Null out the proxy
        try {
            this._screenSaverProxy = null;
        } catch (e) {
            console.error(`ThemeSwitcher: Error nulling ScreenSaver proxy: ${e}`);
        }

        // Unsubscribe from suspend/resume signals
        try {
            if (this._suspendSignalId) {
                Gio.DBus.system.signal_unsubscribe(this._suspendSignalId);
                this._suspendSignalId = null;
            }
        } catch (e) {
            console.error(`ThemeSwitcher: Error unsubscribing from suspend/resume signals: ${e}`);
            this._suspendSignalId = null;
        }

        // Disconnect all settings change signals
        const settingsSignals = [
            { id: '_autoDetectChangedId', name: 'auto-detect' },
            { id: '_lightTriggerChangedId', name: 'light-trigger' },
            { id: '_darkTriggerChangedId', name: 'dark-trigger' },
            { id: '_customLightTimeChangedId', name: 'custom-light-time' },
            { id: '_customDarkTimeChangedId', name: 'custom-dark-time' },
            { id: '_useManualCoordsChangedId', name: 'use-manual-coords' },
            { id: '_manualLatitudeChangedId', name: 'manual-latitude' },
            { id: '_manualLongitudeChangedId', name: 'manual-longitude' },
            { id: '_controlBrightnessChangedId', name: 'control-brightness' },
            { id: '_lightBrightnessChangedId', name: 'light-brightness' },
            { id: '_darkBrightnessChangedId', name: 'dark-brightness' },
        ];

        for (const signal of settingsSignals) {
            try {
                if (this[signal.id]) {
                    if (this._settings) {
                        this._settings.disconnect(this[signal.id]);
                    }
                    this[signal.id] = null;
                }
            } catch (e) {
                console.error(`ThemeSwitcher: Error disconnecting ${signal.name} signal: ${e}`);
                this[signal.id] = null;
            }
        }

        // Unexport DBus interface
        try {
            if (this._dbus) {
                this._dbus.unexport();
                this._dbus = null;
            }
        } catch (e) {
            console.error(`ThemeSwitcher: Error unexporting DBus interface: ${e}`);
            this._dbus = null;
        }

        // Clean up settings objects
        try {
            this._settings = null;
            this._interfaceSettings = null;
            this._colorSettings = null;
        } catch (e) {
            console.error(`ThemeSwitcher: Error cleaning up settings: ${e}`);
        }

        // Clean up other state variables
        try {
            this._debugInfo = null;
            this._lightTime = null;
            this._darkTime = null;
            this._lastBrightnessUpdateTime = null;
            this._latitude = null;
            this._longitude = null;
            this._locationName = null;
        } catch (e) {
            console.error(`ThemeSwitcher: Error cleaning up state variables: ${e}`);
        }
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

    async _getApiDataForCoordinates(latitude, longitude) {
        try {
            console.log(`ThemeSwitcher: Fetching sun times for manual coordinates: ${latitude}, ${longitude}`);
            const session = new Soup.Session();

            // Store coordinates for debug display
            this._latitude = latitude;
            this._longitude = longitude;

            // Get sun times using manual coordinates
            const url = `https://api.sunrisesunset.io/json?lat=${latitude}&lng=${longitude}`;
            const apiMessage = Soup.Message.new('GET', url);
            const apiBytes = await session.send_and_read_async(
                apiMessage,
                GLib.PRIORITY_DEFAULT,
                null
            );
            const apiData = JSON.parse(new TextDecoder().decode(apiBytes.get_data()));

            // Get location name using reverse geocoding
            try {
                const geoUrl = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=10`;
                const geoMessage = Soup.Message.new('GET', geoUrl);
                geoMessage.request_headers.append('User-Agent', 'GNOME-Auto-Theme-Switcher/1.0');
                const geoBytes = await session.send_and_read_async(
                    geoMessage,
                    GLib.PRIORITY_DEFAULT,
                    null
                );
                const geoData = JSON.parse(new TextDecoder().decode(geoBytes.get_data()));

                if (geoData.address) {
                    const parts = [];
                    if (geoData.address.city) parts.push(geoData.address.city);
                    else if (geoData.address.town) parts.push(geoData.address.town);
                    else if (geoData.address.village) parts.push(geoData.address.village);

                    if (geoData.address.state) parts.push(geoData.address.state);
                    if (geoData.address.country) parts.push(geoData.address.country);

                    this._locationName = parts.join(', ') || 'Manual Coordinates';
                } else {
                    this._locationName = 'Manual Coordinates';
                }
            } catch (geoError) {
                console.error(`ThemeSwitcher: Failed to fetch location name: ${geoError}`);
                this._locationName = 'Manual Coordinates';
            }

            return apiData;
        } catch (e) {
            console.error(`ThemeSwitcher: Failed to fetch API data for manual coordinates: ${e}`);
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

        // Update brightness to match the new theme mode
        // This ensures brightness is always correct when theme switches,
        // whether gradual transitions are enabled or not
        this._updateBrightness(true);

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

    async _scheduleNextChangeEvent(isInitialEnable = false) {
        // Clear any existing timeout
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }

        const autoDetectLocation = this._settings.get_boolean('auto-detect-location');
        const useManualCoordinates = this._settings.get_boolean('use-manual-coordinates');
        const now = new Date();

        let lightTime, darkTime, apiData = null;

        if (autoDetectLocation) {
            // Auto-detect mode: Fetch location via IP and get sun times from API
            apiData = await this._getApiData();
            if (!apiData || !apiData.results) {
                // If API fails, retry in 15 minutes
                this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, API_REFRESH_INTERVAL_SECONDS, () => {
                    this._scheduleNextChangeEvent();
                    return GLib.SOURCE_REMOVE;
                });
                return;
            }

            // Get light mode trigger time from API data
            const lightModeTrigger = this._settings.get_string('light-mode-trigger');
            lightTime = this._parseTriggerTime(lightModeTrigger, apiData.results, now, 'light');

            // Get dark mode trigger time from API data
            const darkModeTrigger = this._settings.get_string('dark-mode-trigger');
            darkTime = this._parseTriggerTime(darkModeTrigger, apiData.results, now, 'dark');

            // Store debug info with API data
            this._storeDebugInfo(now, lightTime, darkTime, lightModeTrigger, darkModeTrigger, apiData.results);
        } else if (useManualCoordinates) {
            // Manual coordinates mode: Use entered coordinates to fetch sun times
            const latitude = this._settings.get_string('manual-latitude');
            const longitude = this._settings.get_string('manual-longitude');

            if (!latitude || !longitude) {
                console.error('ThemeSwitcher: Manual coordinates not set, falling back to custom times');
            } else {
                // Fetch sun times using manual coordinates
                apiData = await this._getApiDataForCoordinates(latitude, longitude);
                if (apiData && apiData.results) {
                    // Get light mode trigger time from API data
                    const lightModeTrigger = this._settings.get_string('light-mode-trigger');
                    lightTime = this._parseTriggerTime(lightModeTrigger, apiData.results, now, 'light');

                    // Get dark mode trigger time from API data
                    const darkModeTrigger = this._settings.get_string('dark-mode-trigger');
                    darkTime = this._parseTriggerTime(darkModeTrigger, apiData.results, now, 'dark');

                    // Store debug info with API data
                    this._storeDebugInfo(now, lightTime, darkTime, lightModeTrigger, darkModeTrigger, apiData.results);
                }
            }
        }

        // If we don't have valid times yet (manual coords mode but not set, or API failed), use custom times
        if (!lightTime || !darkTime) {
            const customLightTime = this._settings.get_string('custom-light-time');
            const customDarkTime = this._settings.get_string('custom-dark-time');

            lightTime = this._parseCustomTime(customLightTime, now);
            darkTime = this._parseCustomTime(customDarkTime, now);

            // Store debug info without API data
            this._storeDebugInfo(now, lightTime, darkTime, 'custom', 'custom', null);
        }

        // Validate that we got valid times
        if (!lightTime || !darkTime) {
            this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, API_REFRESH_INTERVAL_SECONDS, () => {
                this._scheduleNextChangeEvent();
                return GLib.SOURCE_REMOVE;
            });
            return;
        }

        // Store times for brightness calculations
        this._lightTime = lightTime;
        this._darkTime = darkTime;

        // Now that we have light/dark times, start brightness control if enabled
        this._scheduleBrightnessUpdates();

        // Determine current mode and next event
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
                nextEventTime = new Date(lightTime.getTime() + MS_PER_DAY);
            }
            this._debugInfo.currentMode = 'night';
        } else {
            // It's currently day. Set light theme. Next event is dark time.
            this._switchTheme(false);
            switchToDark = true;
            nextEventTime = darkTime;
            this._debugInfo.currentMode = 'day';
        }

        const secondsToNextEvent = Math.round((nextEventTime.getTime() - now.getTime()) / MS_PER_SECOND);

        this._debugInfo.nextEventTime = nextEventTime.toLocaleString();
        this._debugInfo.secondsToNextEvent = secondsToNextEvent;
        this._debugInfo.nextEventType = switchToDark ? 'dark' : 'light';

        // Schedule the timeout
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, secondsToNextEvent, () => {
            this._switchTheme(switchToDark);
            this._scheduleNextChangeEvent(); // Reschedule for the next event in the chain
            return GLib.SOURCE_REMOVE; // Important: remove the old timer
        });

        // On login, always set brightness to appropriate value
        // Unlock events are handled separately by session mode signals
        if (isInitialEnable) {
            this._updateBrightness(true); // Allow static brightness on login
        }
    }

    _parseTriggerTime(trigger, apiResults, now, mode) {
        // Parse trigger time from API data based on trigger type
        // mode is 'light' or 'dark'

        if (trigger === 'custom') {
            // Use custom time
            const customTimeSetting = mode === 'light' ? 'custom-light-time' : 'custom-dark-time';
            const customTime = this._settings.get_string(customTimeSetting);
            return this._parseCustomTime(customTime, now);
        }

        // Map trigger name to API field
        let apiField;
        if (trigger === 'first-light') {
            apiField = 'first_light';
        } else if (trigger === 'dawn') {
            apiField = 'dawn';
        } else if (trigger === 'sunrise') {
            apiField = 'sunrise';
        } else if (trigger === 'solar-noon') {
            apiField = 'solar_noon';
        } else if (trigger === 'golden-hour') {
            apiField = 'golden_hour';
        } else if (trigger === 'sunset') {
            apiField = 'sunset';
        } else if (trigger === 'dusk') {
            apiField = 'dusk';
        } else if (trigger === 'last-light') {
            apiField = 'last_light';
        } else {
            // Default fallback
            console.error(`ThemeSwitcher: Unknown trigger '${trigger}', using default`);
            apiField = mode === 'light' ? 'sunrise' : 'sunset';
        }

        return this._parseTime(apiResults[apiField]);
    }

    _parseCustomTime(timeString, now) {
        // Parse HH:MM format time string and return Date object for today
        const timeParts = timeString.split(':');
        if (timeParts.length >= 2) {
            const h = parseInt(timeParts[0], 10);
            const m = parseInt(timeParts[1], 10);
            if (!isNaN(h) && !isNaN(m) && h >= 0 && h < 24 && m >= 0 && m < 60) {
                return new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0);
            } else {
                console.error(`ThemeSwitcher: Invalid custom time format: ${timeString}`);
                return null;
            }
        } else {
            console.error(`ThemeSwitcher: Invalid custom time format: ${timeString}`);
            return null;
        }
    }

    _storeDebugInfo(now, lightTime, darkTime, lightTrigger, darkTrigger, apiResults) {
        // Store current state for debug panel
        // Calculate brightness information if control is enabled
        const controlBrightness = this._settings.get_boolean('control-brightness');

        // Always read the last update timestamp from persistent storage
        const lastUpdateStr = this._settings.get_string('last-brightness-update');
        const lastUpdateTimestamp = parseInt(lastUpdateStr, 10) || 0;

        let brightnessInfo = {
            enabled: controlBrightness,
            lightBrightness: 'N/A',
            darkBrightness: 'N/A',
            currentBrightness: 'N/A',
            trend: 'N/A',
            nextUpdateIn: 'N/A',
            lastUpdateTimestamp: lastUpdateTimestamp, // ALWAYS include this
        };

        if (controlBrightness && lightTime && darkTime) {
            const lightBrightness = this._settings.get_int('light-brightness');
            const darkBrightness = this._settings.get_int('dark-brightness');

            // Calculate brightness using the provided times (or fallback to stored times)
            const calcLightTime = lightTime || this._lightTime;
            const calcDarkTime = darkTime || this._darkTime;

            // Store times temporarily for calculation
            const prevLightTime = this._lightTime;
            const prevDarkTime = this._darkTime;
            this._lightTime = calcLightTime;
            this._darkTime = calcDarkTime;

            const currentBrightness = this._calculateBrightness(now, lightBrightness, darkBrightness);

            // Restore previous times if they were different
            if (prevLightTime) this._lightTime = prevLightTime;
            if (prevDarkTime) this._darkTime = prevDarkTime;

            // Get gradual transition settings
            const gradualDecreaseEnabled = this._settings.get_boolean('gradual-brightness-decrease-enabled');
            const gradualIncreaseEnabled = this._settings.get_boolean('gradual-brightness-increase-enabled');
            const decreaseDuration = this._settings.get_int('gradual-brightness-decrease-duration');
            const increaseDuration = this._settings.get_int('gradual-brightness-increase-duration');

            // Determine current brightness state and next transition
            let brightnessState = 'N/A';
            let nextTransition = 'N/A';

            const inDayPeriod = now >= calcLightTime && now < calcDarkTime;

            if (inDayPeriod) {
                // During day period
                if (gradualDecreaseEnabled) {
                    const dimStartTime = new Date(calcDarkTime.getTime() - (decreaseDuration * MS_PER_SECOND));

                    if (now < dimStartTime) {
                        brightnessState = 'Not in adjustment window';
                        const timeUntilDim = Math.round((dimStartTime.getTime() - now.getTime()) / MS_PER_SECOND);
                        const hours = Math.floor(timeUntilDim / 3600);
                        const minutes = Math.floor((timeUntilDim % 3600) / 60);
                        nextTransition = `Dimming starts in ${hours > 0 ? hours + 'h ' : ''}${minutes}m`;
                    } else if (now < calcDarkTime) {
                        const progress = Math.round(((now.getTime() - dimStartTime.getTime()) / (decreaseDuration * MS_PER_SECOND)) * 100);
                        brightnessState = `Dimming (${progress}%)`;
                        nextTransition = `Reaches ${darkBrightness}% at dark mode`;
                    } else {
                        brightnessState = `At ${darkBrightness}%`;
                    }
                } else {
                    brightnessState = 'Not in adjustment window (gradual decrease disabled)';
                    nextTransition = 'N/A';
                }
            } else {
                // During night period
                let nextLightTime = calcLightTime;
                if (now >= calcDarkTime) {
                    nextLightTime = new Date(calcLightTime.getTime() + MS_PER_DAY);
                }

                if (gradualIncreaseEnabled) {
                    const brightenStartTime = new Date(nextLightTime.getTime() - (increaseDuration * MS_PER_SECOND));

                    if (now < brightenStartTime) {
                        brightnessState = 'Not in adjustment window';
                        const timeUntilBrighten = Math.round((brightenStartTime.getTime() - now.getTime()) / MS_PER_SECOND);
                        const hours = Math.floor(timeUntilBrighten / 3600);
                        const minutes = Math.floor((timeUntilBrighten % 3600) / 60);
                        nextTransition = `Brightening starts in ${hours > 0 ? hours + 'h ' : ''}${minutes}m`;
                    } else if (now < nextLightTime) {
                        const progress = Math.round(((now.getTime() - brightenStartTime.getTime()) / (increaseDuration * MS_PER_SECOND)) * 100);
                        brightnessState = `Brightening (${progress}%)`;
                        nextTransition = `Reaches ${lightBrightness}% at light mode`;
                    } else {
                        brightnessState = `At ${lightBrightness}%`;
                    }
                } else {
                    brightnessState = 'Not in adjustment window (gradual increase disabled)';
                    nextTransition = 'N/A';
                }
            }

            brightnessInfo = {
                enabled: true,
                lightBrightness: `${lightBrightness}%`,
                darkBrightness: `${darkBrightness}%`,
                currentBrightness: currentBrightness !== null ? `${currentBrightness}%` : 'N/A (outside adjustment window)',
                brightnessState: brightnessState,
                nextTransition: nextTransition,
                lastUpdateTimestamp: lastUpdateTimestamp, // Send the actual stored timestamp
            };
        }

        // Preserve existing theme switching info if available, otherwise use defaults
        const existingDebugInfo = this._debugInfo || {};

        this._debugInfo = {
            apiData: apiResults || existingDebugInfo.apiData || null,
            currentTime: now.toLocaleString(),
            lightTime: lightTime ? lightTime.toLocaleString() : 'N/A',
            darkTime: darkTime ? darkTime.toLocaleString() : 'N/A',
            lightModeTrigger: lightTrigger,
            darkModeTrigger: darkTrigger,
            currentMode: existingDebugInfo.currentMode || 'N/A',
            nextEventTime: existingDebugInfo.nextEventTime || 'N/A',
            secondsToNextEvent: existingDebugInfo.secondsToNextEvent || 0,
            nextEventType: existingDebugInfo.nextEventType || 'N/A',
            latitude: this._latitude || 'N/A',
            longitude: this._longitude || 'N/A',
            locationName: this._locationName || 'Unknown',
            brightness: brightnessInfo,
        };
    }

    async _checkCommandAvailable(command) {
        try {
            const proc = new Gio.Subprocess({
                argv: ['which', command],
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
            });
            proc.init(null);

            // Wait for the process to complete
            await proc.wait_check_async(null);
            const success = proc.get_successful();

            return success;
        } catch (e) {
            // Command not found or failed - this is expected for 'which' when command doesn't exist
            return false;
        }
    }

    async _scheduleBrightnessUpdates() {
        // Clear any existing brightness timer
        if (this._brightnessTimeoutId) {
            GLib.source_remove(this._brightnessTimeoutId);
            this._brightnessTimeoutId = null;
        }

        const controlBrightness = this._settings.get_boolean('control-brightness');
        if (!controlBrightness) {
            return;
        }

        // Check if brightnessctl is available
        const isBrightnessctlAvailable = await this._checkCommandAvailable('brightnessctl');
        if (!isBrightnessctlAvailable) {
            return;
        }

        if (!this._lightTime || !this._darkTime) {
            return;
        }

        const now = new Date();
        const gradualDecreaseEnabled = this._settings.get_boolean('gradual-brightness-decrease-enabled');
        const gradualIncreaseEnabled = this._settings.get_boolean('gradual-brightness-increase-enabled');

        if (!gradualDecreaseEnabled && !gradualIncreaseEnabled) {
            return;
        }

        const decreaseDuration = this._settings.get_int('gradual-brightness-decrease-duration') * MS_PER_SECOND;
        const increaseDuration = this._settings.get_int('gradual-brightness-increase-duration') * MS_PER_SECOND;

        // Calculate when the next adjustment window starts
        const inDayPeriod = now >= this._lightTime && now < this._darkTime;
        let nextWindowStart;
        let nextWindowEnd;

        if (inDayPeriod) {
            // During day period - check if we have a dimming window
            if (gradualDecreaseEnabled) {
                const dimStartTime = new Date(this._darkTime.getTime() - decreaseDuration);
                if (now < dimStartTime) {
                    // Before dimming window starts
                    nextWindowStart = dimStartTime;
                    nextWindowEnd = this._darkTime;
                } else if (now < this._darkTime) {
                    // Currently in dimming window
                    nextWindowStart = now;
                    nextWindowEnd = this._darkTime;
                } else {
                    // This shouldn't happen in day period, but handle it
                    nextWindowStart = null;
                }
            } else {
                nextWindowStart = null;
            }
        } else {
            // During night period - check if we have a brightening window
            if (gradualIncreaseEnabled) {
                let nextLightTime = this._lightTime;
                if (now >= this._darkTime) {
                    nextLightTime = new Date(this._lightTime.getTime() + MS_PER_DAY);
                }

                const brightenStartTime = new Date(nextLightTime.getTime() - increaseDuration);
                if (now < brightenStartTime) {
                    // Before brightening window starts
                    nextWindowStart = brightenStartTime;
                    nextWindowEnd = nextLightTime;
                } else if (now < nextLightTime) {
                    // Currently in brightening window
                    nextWindowStart = now;
                    nextWindowEnd = nextLightTime;
                } else {
                    // This shouldn't happen, but handle it
                    nextWindowStart = null;
                }
            } else {
                nextWindowStart = null;
            }
        }

        // If no window found, need to check the next period
        if (!nextWindowStart) {
            // Calculate next window in the opposite period
            if (inDayPeriod && gradualIncreaseEnabled) {
                // We're in day, next window is tomorrow's brightening
                const tomorrowLightTime = new Date(this._lightTime.getTime() + MS_PER_DAY);
                nextWindowStart = new Date(tomorrowLightTime.getTime() - increaseDuration);
                nextWindowEnd = tomorrowLightTime;
            } else if (!inDayPeriod && gradualDecreaseEnabled) {
                // We're in night, next window is today's or tomorrow's dimming
                const nextDarkTime = now >= this._darkTime ?
                    new Date(this._darkTime.getTime() + MS_PER_DAY) :
                    this._darkTime;
                nextWindowStart = new Date(nextDarkTime.getTime() - decreaseDuration);
                nextWindowEnd = nextDarkTime;
            } else {
                return;
            }
        }

        const secondsUntilWindowStart = Math.max(0, Math.round((nextWindowStart.getTime() - now.getTime()) / MS_PER_SECOND));

        if (secondsUntilWindowStart > 0) {
            // Schedule to start when the window begins
            this._brightnessTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, secondsUntilWindowStart, () => {
                this._startBrightnessUpdateLoop(nextWindowEnd);
                return GLib.SOURCE_REMOVE;
            });
        } else {
            // We're already in a window, start updating now
            this._startBrightnessUpdateLoop(nextWindowEnd);
        }
    }

    _startBrightnessUpdateLoop(windowEnd) {
        // Update immediately
        this._updateBrightness();

        // Clear any existing timer
        if (this._brightnessTimeoutId) {
            GLib.source_remove(this._brightnessTimeoutId);
            this._brightnessTimeoutId = null;
        }

        // Schedule updates every 10 minutes until window ends
        this._brightnessTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, BRIGHTNESS_UPDATE_INTERVAL_SECONDS, () => {
            const now = new Date();

            // Check if we're still in the adjustment window
            if (now >= windowEnd) {
                this._scheduleBrightnessUpdates(); // Schedule for next window
                return GLib.SOURCE_REMOVE;
            }

            this._updateBrightness();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _updateBrightness(allowStaticBrightness = false) {
        const controlBrightness = this._settings.get_boolean('control-brightness');
        if (!controlBrightness || !this._lightTime || !this._darkTime) {
            return;
        }

        const now = new Date();
        const lightBrightness = this._settings.get_int('light-brightness');
        const darkBrightness = this._settings.get_int('dark-brightness');

        // Calculate transitional brightness (returns null if outside adjustment window)
        const transitionalBrightness = this._calculateBrightness(now, lightBrightness, darkBrightness);

        let targetBrightness;
        if (transitionalBrightness !== null) {
            // We're in an adjustment window - use calculated transitional value
            targetBrightness = transitionalBrightness;
        } else if (allowStaticBrightness) {
            // Outside adjustment window but static brightness is allowed (login only)
            const inDayPeriod = now >= this._lightTime && now < this._darkTime;
            targetBrightness = inDayPeriod ? lightBrightness : darkBrightness;
        } else {
            // Outside adjustment window and not allowed to set static - do nothing (unlock scenario)
            return;
        }

        try {
            GLib.spawn_command_line_async(`brightnessctl set ${targetBrightness}%`);
            // Store the last update time for debug panel
            this._lastBrightnessUpdateTime = now.getTime();
            this._settings.set_string('last-brightness-update', this._lastBrightnessUpdateTime.toString());
        } catch (e) {
            console.error(`ThemeSwitcher: Failed to set brightness: ${e}`);
        }
    }

    _calculateBrightness(now, lightBrightness, darkBrightness) {
        const lightTime = this._lightTime;
        const darkTime = this._darkTime;

        // Get gradual transition settings
        const gradualDecreaseEnabled = this._settings.get_boolean('gradual-brightness-decrease-enabled');
        const gradualIncreaseEnabled = this._settings.get_boolean('gradual-brightness-increase-enabled');
        const decreaseDuration = this._settings.get_int('gradual-brightness-decrease-duration') * MS_PER_SECOND; // Convert to ms
        const increaseDuration = this._settings.get_int('gradual-brightness-increase-duration') * MS_PER_SECOND; // Convert to ms

        // Determine if we're in day or night period
        let inDayPeriod = now >= lightTime && now < darkTime;

        // Handle edge case where we're past dark time or before light time (night)
        if (now >= darkTime || now < lightTime) {
            inDayPeriod = false;
        }

        if (inDayPeriod) {
            // During day period (light mode is active)

            if (gradualDecreaseEnabled) {
                // Calculate when dimming should start (before dark mode trigger)
                const dimStartTime = new Date(darkTime.getTime() - decreaseDuration);

                if (now >= dimStartTime && now < darkTime) {
                    // We're in the dimming window - gradual transition
                    const elapsed = now.getTime() - dimStartTime.getTime();
                    const progress = elapsed / decreaseDuration;

                    // Linear interpolation from light to dark
                    const brightness = lightBrightness + (darkBrightness - lightBrightness) * progress;
                    return Math.round(Math.max(1, Math.min(100, brightness)));
                } else {
                    // Before dimming window - not in adjustment scope
                    return null;
                }
            } else {
                // Gradual decrease disabled - no brightness control needed
                return null;
            }
        } else {
            // During night period (dark mode is active)

            // Figure out when the next light time is
            let nextLightTime = lightTime;
            if (now >= darkTime) {
                // We're past dark time today, so next light is tomorrow
                nextLightTime = new Date(lightTime.getTime() + MS_PER_DAY);
            }

            if (gradualIncreaseEnabled) {
                // Calculate when brightening should start (before light mode trigger)
                const brightenStartTime = new Date(nextLightTime.getTime() - increaseDuration);

                if (now >= brightenStartTime && now < nextLightTime) {
                    // We're in the brightening window - gradual transition
                    const elapsed = now.getTime() - brightenStartTime.getTime();
                    const progress = elapsed / increaseDuration;

                    // Linear interpolation from dark to light
                    const brightness = darkBrightness + (lightBrightness - darkBrightness) * progress;
                    return Math.round(Math.max(1, Math.min(100, brightness)));
                } else {
                    // Before brightening window - not in adjustment scope
                    return null;
                }
            } else {
                // Gradual increase disabled - no brightness control needed
                return null;
            }
        }
    }
}
