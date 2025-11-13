import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {
    API_REFRESH_INTERVAL_SECONDS,
    RESUME_DELAY_SECONDS,
    MS_PER_SECOND,
    MS_PER_DAY
} from './constants.js';
import { BrightnessController } from './brightnessController.js';
import { ThemeController } from './themeController.js';
import { APIClient } from './apiClient.js';
import { TimeCalculator } from './timeCalculator.js';

export class ExtensionController {
    constructor(extension) {
        console.log(`ThemeSwitcher: ExtensionController constructor called`);
        this._extension = extension;
        this._settings = extension.getSettings();
        this._scheduleTimeoutId = null;
        this._apiRetryTimeoutId = null;
        this._resumeTimeoutId = null;
        this._debugInfo = null;
        this._manualModeActive = false;
        this._lightTime = null;
        this._darkTime = null;
        this._sessionModeSignalId = null;
        this._screenSaverProxy = null;
        this._screenSaverSignalId = null;
        this._suspendSignalId = null;

        // Initialize controllers and helpers
        this._brightnessController = new BrightnessController(this._settings);
        this._themeController = new ThemeController(this._settings);
        this._apiClient = new APIClient();
        this._timeCalculator = new TimeCalculator();
        console.log(`ThemeSwitcher: ExtensionController constructed successfully`);
    }

    enable() {
        console.log(`ThemeSwitcher: ExtensionController.enable() called`);
        // Initialize default themes from current system theme on first run
        this._themeController.initializeDefaultThemes();

        // Setup lock/unlock detection
        this._setupLockUnlockDetection();

        // Listen for system suspend/resume events
        this._setupSuspendResumeHandler();

        // Listen for settings changes that require re-scheduling
        this._setupSettingsListeners();

        // Run the main logic loop (async, but we don't await to avoid blocking enable())
        this._scheduleNextChangeEvent(true).catch(e => {
            console.error(`ThemeSwitcher: Error in initial scheduling: ${e}`);
            console.error(`ThemeSwitcher: Stack trace:`, e.stack);
        });
    }

    _setupSettingsListeners() {
        const scheduleSettings = [
            'auto-detect-location',
            'light-mode-trigger',
            'dark-mode-trigger',
            'custom-light-time',
            'custom-dark-time',
            'use-manual-coordinates',
            'manual-latitude',
            'manual-longitude',
        ];

        scheduleSettings.forEach(setting => {
            const id = `_${setting.replace(/-/g, '_')}ChangedId`;
            this[id] = this._settings.connect(`changed::${setting}`, () => {
                if (!this._manualModeActive) {
                    this._scheduleNextChangeEvent();
                }
            });
        });

        this._controlBrightnessChangedId = this._settings.connect('changed::control-brightness', () => {
            this._brightnessController.scheduleBrightnessUpdates();
        });

        this._lightBrightnessChangedId = this._settings.connect('changed::light-brightness', () => {
            this._brightnessController.updateBrightness();
        });

        this._darkBrightnessChangedId = this._settings.connect('changed::dark-brightness', () => {
            this._brightnessController.updateBrightness();
        });
    }

    _setupLockUnlockDetection() {
        // JUSTIFICATION FOR unlock-dialog SESSION MODE:
        // This extension includes "unlock-dialog" in session-modes to remain active during screen lock.
        // This is necessary to:
        // 1. Detect unlock events via Main.sessionMode transitions (user <-> unlock-dialog)
        // 2. Apply brightness adjustments ONLY when within a gradual transition window on unlock
        // 3. Avoid adjusting brightness on every unlock (which would be disruptive)
        // Without unlock-dialog mode, the extension would be disabled during lock and re-enabled
        // on unlock, causing enable() to run and always adjust brightness (undesired behavior).
        // This extension does NOT connect to any keyboard events in unlock-dialog mode.
        this._setupSessionModeHandler();
        this._setupScreenSaverHandler().catch(e => {
            console.error(`ThemeSwitcher: Error setting up screen saver handler: ${e}`);
        });
    }

    _setupSessionModeHandler() {
        this._sessionModeSignalId = Main.sessionMode.connect('updated', () => {
            const currentMode = Main.sessionMode.currentMode;
            const parentMode = Main.sessionMode.parentMode;

            if (currentMode === 'user' || parentMode === 'user') {
                this._brightnessController.updateBrightness(false);
            }
        });
    }

    async _setupScreenSaverHandler() {
        this._screenSaverProxy = await Gio.DBusProxy.new(
            Gio.DBus.session,
            Gio.DBusProxyFlags.NONE,
            null,
            'org.gnome.ScreenSaver',
            '/org/gnome/ScreenSaver',
            'org.gnome.ScreenSaver',
            null
        );

        this._screenSaverSignalId = this._screenSaverProxy.connectSignal('ActiveChanged', (_proxy, _sender, [isActive]) => {
            if (!isActive) {
                this._brightnessController.updateBrightness(false);
            }
        });
    }

    _setupSuspendResumeHandler() {
        this._suspendSignalId = Gio.DBus.system.signal_subscribe(
            'org.freedesktop.login1',
            'org.freedesktop.login1.Manager',
            'PrepareForSleep',
            '/org/freedesktop/login1',
            null,
            Gio.DBusSignalFlags.NONE,
            (_connection, _sender, _path, _iface, _signal, params) => {
                const [sleeping] = params.deep_unpack();
                if (!sleeping) {
                    if (this._resumeTimeoutId) {
                        GLib.source_remove(this._resumeTimeoutId);
                        this._resumeTimeoutId = null;
                    }
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
    }

    getDebugInfo() {
        const now = new Date();
        const lightTrigger = this._settings.get_string('light-mode-trigger');
        const darkTrigger = this._settings.get_string('dark-mode-trigger');

        this._storeDebugInfo(now, this._lightTime, this._darkTime, lightTrigger, darkTrigger, null);
        return JSON.stringify(this._debugInfo || {});
    }

    forceThemeSwitch(isDark) {
        this._manualModeActive = true;
        this._themeController.switchTheme(isDark, false, true);
    }

    resetToAutomatic() {
        this._manualModeActive = false;
        this._scheduleNextChangeEvent();
    }

    disable() {
        // JUSTIFICATION FOR SESSION MODE CLEANUP:
        // This extension uses "unlock-dialog" session mode to remain active during screen lock.
        // We must properly disconnect from session mode signals and clean up all resources
        // to prevent memory leaks and ensure the extension can be cleanly re-enabled.

        // Clean up all timers
        if (this._scheduleTimeoutId) {
            GLib.source_remove(this._scheduleTimeoutId);
            this._scheduleTimeoutId = null;
        }
        if (this._apiRetryTimeoutId) {
            GLib.source_remove(this._apiRetryTimeoutId);
            this._apiRetryTimeoutId = null;
        }
        if (this._resumeTimeoutId) {
            GLib.source_remove(this._resumeTimeoutId);
            this._resumeTimeoutId = null;
        }

        // Disconnect session mode signal
        if (this._sessionModeSignalId) {
            Main.sessionMode.disconnect(this._sessionModeSignalId);
            this._sessionModeSignalId = null;
        }

        // Disconnect ScreenSaver D-Bus signal
        if (this._screenSaverProxy && this._screenSaverSignalId) {
            this._screenSaverProxy.disconnectSignal(this._screenSaverSignalId);
            this._screenSaverSignalId = null;
        }
        this._screenSaverProxy = null;

        // Unsubscribe from suspend/resume signals
        if (this._suspendSignalId) {
            Gio.DBus.system.signal_unsubscribe(this._suspendSignalId);
            this._suspendSignalId = null;
        }

        // Disconnect all settings change signals
        const settingsSignals = [
            '_auto_detect_locationChangedId',
            '_light_mode_triggerChangedId',
            '_dark_mode_triggerChangedId',
            '_custom_light_timeChangedId',
            '_custom_dark_timeChangedId',
            '_use_manual_coordinatesChangedId',
            '_manual_latitudeChangedId',
            '_manual_longitudeChangedId',
            '_controlBrightnessChangedId',
            '_lightBrightnessChangedId',
            '_darkBrightnessChangedId',
        ];

        for (const signalId of settingsSignals) {
            if (this[signalId] && this._settings) {
                this._settings.disconnect(this[signalId]);
                this[signalId] = null;
            }
        }

        // Clean up controllers
        if (this._brightnessController) {
            this._brightnessController.cleanup();
            this._brightnessController = null;
        }
        if (this._themeController) {
            this._themeController.cleanup();
            this._themeController = null;
        }

        // Clean up API client
        if (this._apiClient) {
            this._apiClient.destroy();
            this._apiClient = null;
        }

        // Clean up all references
        this._settings = null;
        this._debugInfo = null;
        this._lightTime = null;
        this._darkTime = null;
        this._timeCalculator = null;
        this._extension = null;
    }

    async _scheduleNextChangeEvent(isInitialEnable = false) {
        // Clear all scheduling timeouts
        if (this._scheduleTimeoutId) {
            GLib.source_remove(this._scheduleTimeoutId);
            this._scheduleTimeoutId = null;
        }
        if (this._apiRetryTimeoutId) {
            GLib.source_remove(this._apiRetryTimeoutId);
            this._apiRetryTimeoutId = null;
        }

        const autoDetectLocation = this._settings.get_boolean('auto-detect-location');
        const useManualCoordinates = this._settings.get_boolean('use-manual-coordinates');
        const now = new Date();

        let lightTime, darkTime, apiData = null;
        let lightModeTrigger, darkModeTrigger;

        if (autoDetectLocation) {
            apiData = await this._apiClient.getApiData();
            console.log(`ThemeSwitcher: API data received:`, apiData ? 'success' : 'failed');
            if (!apiData || !apiData.results) {
                console.error(`ThemeSwitcher: API call failed or no results`);
                this._apiRetryTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, API_REFRESH_INTERVAL_SECONDS, () => {
                    this._scheduleNextChangeEvent();
                    return GLib.SOURCE_REMOVE;
                });
                return;
            }

            lightModeTrigger = this._settings.get_string('light-mode-trigger');
            lightTime = this._timeCalculator.parseTriggerTime(lightModeTrigger, apiData.results, now, 'light', this._settings);
            console.log(`ThemeSwitcher: Parsed light time (${lightModeTrigger}):`, lightTime);

            darkModeTrigger = this._settings.get_string('dark-mode-trigger');
            darkTime = this._timeCalculator.parseTriggerTime(darkModeTrigger, apiData.results, now, 'dark', this._settings);
            console.log(`ThemeSwitcher: Parsed dark time (${darkModeTrigger}):`, darkTime);
        } else if (useManualCoordinates) {
            const latitude = this._settings.get_string('manual-latitude');
            const longitude = this._settings.get_string('manual-longitude');

            if (!latitude || !longitude) {
                console.error('ThemeSwitcher: Manual coordinates not set, falling back to custom times');
            } else {
                apiData = await this._apiClient.getApiDataForCoordinates(latitude, longitude);
                if (apiData && apiData.results) {
                    lightModeTrigger = this._settings.get_string('light-mode-trigger');
                    lightTime = this._timeCalculator.parseTriggerTime(lightModeTrigger, apiData.results, now, 'light', this._settings);

                    darkModeTrigger = this._settings.get_string('dark-mode-trigger');
                    darkTime = this._timeCalculator.parseTriggerTime(darkModeTrigger, apiData.results, now, 'dark', this._settings);
                }
            }
        }

        if (!lightTime || !darkTime) {
            const customLightTime = this._settings.get_string('custom-light-time');
            const customDarkTime = this._settings.get_string('custom-dark-time');

            lightTime = this._timeCalculator.parseCustomTime(customLightTime, now);
            darkTime = this._timeCalculator.parseCustomTime(customDarkTime, now);
            lightModeTrigger = 'custom';
            darkModeTrigger = 'custom';
        }

        if (!lightTime || !darkTime) {
            console.error(`ThemeSwitcher: Failed to calculate times - lightTime: ${lightTime}, darkTime: ${darkTime}`);
            this._apiRetryTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, API_REFRESH_INTERVAL_SECONDS, () => {
                this._scheduleNextChangeEvent();
                return GLib.SOURCE_REMOVE;
            });
            return;
        }

        this._lightTime = lightTime;
        this._darkTime = darkTime;

        // Update brightness controller with new times
        this._brightnessController.setTimes(lightTime, darkTime);
        this._brightnessController.scheduleBrightnessUpdates();

        // Store debug info (after setting times so calculateBrightness works)
        this._storeDebugInfo(now, lightTime, darkTime, lightModeTrigger, darkModeTrigger, apiData ? apiData.results : null);

        // Determine current mode and next event
        let nextEventTime, switchToDark;
        if (now >= darkTime || now < lightTime) {
            this._themeController.switchTheme(true, true, this._manualModeActive);
            this._brightnessController.updateBrightness(true);
            switchToDark = false;
            if (now < lightTime) {
                nextEventTime = lightTime;
            } else {
                nextEventTime = new Date(lightTime.getTime() + MS_PER_DAY);
            }
            this._debugInfo.currentMode = 'night';
        } else {
            this._themeController.switchTheme(false, true, this._manualModeActive);
            this._brightnessController.updateBrightness(true);
            switchToDark = true;
            nextEventTime = darkTime;
            this._debugInfo.currentMode = 'day';
        }

        const secondsToNextEvent = Math.round((nextEventTime.getTime() - now.getTime()) / MS_PER_SECOND);

        this._debugInfo.nextEventTime = nextEventTime.toLocaleString();
        this._debugInfo.secondsToNextEvent = secondsToNextEvent;
        this._debugInfo.nextEventType = switchToDark ? 'dark' : 'light';

        this._scheduleTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, secondsToNextEvent, () => {
            this._themeController.switchTheme(switchToDark, true, this._manualModeActive);
            this._brightnessController.updateBrightness(true);
            this._scheduleNextChangeEvent();
            return GLib.SOURCE_REMOVE;
        });

        if (isInitialEnable) {
            this._brightnessController.updateBrightness(true);
        }
    }

    _storeDebugInfo(now, lightTime, darkTime, lightTrigger, darkTrigger, apiResults) {
        const controlBrightness = this._settings.get_boolean('control-brightness');

        const lastUpdateStr = this._settings.get_string('last-brightness-update');
        const lastUpdateTimestamp = parseInt(lastUpdateStr, 10) || 0;

        let brightnessInfo = {
            enabled: controlBrightness,
            lightBrightness: 'N/A',
            darkBrightness: 'N/A',
            currentBrightness: 'N/A',
            trend: 'N/A',
            nextUpdateIn: 'N/A',
            lastUpdateTimestamp: lastUpdateTimestamp,
        };

        if (controlBrightness && lightTime && darkTime) {
            const lightBrightness = this._settings.get_int('light-brightness');
            const darkBrightness = this._settings.get_int('dark-brightness');

            const currentBrightness = this._brightnessController.calculateBrightness(now, lightBrightness, darkBrightness);

            const gradualDecreaseEnabled = this._settings.get_boolean('gradual-brightness-decrease-enabled');
            const gradualIncreaseEnabled = this._settings.get_boolean('gradual-brightness-increase-enabled');
            const decreaseDuration = this._settings.get_int('gradual-brightness-decrease-duration');
            const increaseDuration = this._settings.get_int('gradual-brightness-increase-duration');

            let brightnessState = 'N/A';
            let nextTransition = 'N/A';

            const inDayPeriod = now >= lightTime && now < darkTime;

            if (inDayPeriod) {
                if (gradualDecreaseEnabled) {
                    const dimStartTime = new Date(darkTime.getTime() - (decreaseDuration * MS_PER_SECOND));

                    if (now < dimStartTime) {
                        brightnessState = 'Not in adjustment window';
                        const timeUntilDim = Math.round((dimStartTime.getTime() - now.getTime()) / MS_PER_SECOND);
                        const hours = Math.floor(timeUntilDim / 3600);
                        const minutes = Math.floor((timeUntilDim % 3600) / 60);
                        nextTransition = `Dimming starts in ${hours > 0 ? hours + 'h ' : ''}${minutes}m`;
                    } else if (now < darkTime) {
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
                let nextLightTime = lightTime;
                if (now >= darkTime) {
                    nextLightTime = new Date(lightTime.getTime() + MS_PER_DAY);
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
                lastUpdateTimestamp: lastUpdateTimestamp,
            };
        }

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
            latitude: this._apiClient.latitude || 'N/A',
            longitude: this._apiClient.longitude || 'N/A',
            locationName: this._apiClient.locationName || 'Unknown',
            brightness: brightnessInfo,
        };
    }
}
