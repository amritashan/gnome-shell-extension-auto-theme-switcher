import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {
    RESUME_DELAY_SECONDS,
    MS_PER_SECOND,
    MS_PER_DAY
} from './constants.js';
import { BrightnessController } from './brightnessController.js';
import { ThemeController } from './themeController.js';
import { SolarCalculator } from './solarCalculator.js';
import { TimeCalculator } from './timeCalculator.js';

export class ExtensionController {
    constructor(extension) {
        this._extension = extension;
        this._settings = extension.getSettings();
        this._scheduleTimeoutId = null;
        this._resumeTimeoutId = null;
        this._debugInfo = null;
        this._manualModeActive = false;
        this._lightTime = null;
        this._darkTime = null;
        this._sessionModeSignalId = null;
        this._screenSaverProxy = null;
        this._screenSaverSignalId = null;
        this._suspendSignalId = null;
        this._monitorsChangedId = null;

        // Initialize controllers and helpers
        this._brightnessController = new BrightnessController(this._settings);
        this._themeController = new ThemeController(this._settings);
        this._solarCalculator = new SolarCalculator();
        this._timeCalculator = new TimeCalculator();
    }

    enable() {
        // Initialize default themes from current system theme on first run
        this._themeController.initializeDefaultThemes();

        // Setup lock/unlock detection
        this._setupLockUnlockDetection();

        // Listen for monitor hotplug / readiness changes
        this._setupMonitorsChangedHandler();

        // Listen for system suspend/resume events
        this._setupSuspendResumeHandler();

        // Listen for settings changes that require re-scheduling
        this._setupSettingsListeners();

        // Check for pending migration notifications
        this._showMigrationNotificationIfPending();

        // Run the main logic loop
        this._scheduleNextChangeEvent();
    }

    /**
     * Check for pending migration notifications and show them.
     * The MigrationManager sets a flag when migrations complete that require user attention.
     * @private
     */
    _showMigrationNotificationIfPending() {
        const pendingNotification = this._settings.get_string('migration-notification-pending');

        if (pendingNotification === 'v0-to-v1') {
            // Show notification about location detection changes
            Main.notify(
                'Auto Theme Switcher Updated',
                'Location setting has changed. Please set your location in the extension preferences to enable solar-based theme switching.'
            );

            // Clear the pending notification
            this._settings.set_string('migration-notification-pending', '');
            console.log('ExtensionController: Showed v0-to-v1 migration notification');
        }
    }

    _setupSettingsListeners() {
        const scheduleSettings = [
            'light-mode-trigger',
            'dark-mode-trigger',
            'custom-light-time',
            'custom-dark-time',
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

        // Note: We don't watch 'changed::monitors' to avoid race conditions with preview/restore
        // in the preferences dialog. Brightness changes are applied during theme transitions only.

        this._trueLightModeChangedId = this._settings.connect('changed::true-light-mode', () => {
            // When true-light-mode setting changes, immediately re-apply theme if currently in light mode
            // This provides instant visual feedback when toggling the setting
            if (this._themeController.isCurrentlyInLightMode()) {
                this._themeController.switchTheme(false, false, this._manualModeActive);
            }
        });
    }

    _setupLockUnlockDetection() {
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
                // Fire-and-forget async brightness update
                this._brightnessController.updateBrightness(false).catch(e => {
                    console.error('ExtensionController: Failed to update brightness on session mode change:', e);
                });
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
                // Fire-and-forget async brightness update
                this._brightnessController.updateBrightness(false).catch(e => {
                    console.error('ExtensionController: Failed to update brightness after screen unlock:', e);
                });
            }
        });
    }

    _setupMonitorsChangedHandler() {
        const monitorManager = global.backend.get_monitor_manager();
        this._monitorsChangedId = monitorManager.connect('monitors-changed', () => {
            console.log('ExtensionController: Monitors changed, re-applying brightness');
            this._brightnessController.updateBrightness(true).catch(e => {
                console.error('ExtensionController: Failed to update brightness after monitors changed:', e);
            });
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
                    this._resumeTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, RESUME_DELAY_SECONDS, () => {
                        if (!this._manualModeActive) {
                            this._scheduleNextChangeEvent();
                        }
                        this._resumeTimeoutId = null;
                        return GLib.SOURCE_REMOVE;
                    });
                }
            }
        );
    }

    getDebugInfo() {
        // Return the existing debug info without overwriting it
        // The debug info is populated by _scheduleNextChangeEvent() with correct solar times
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
        // Clean up all timers
        if (this._scheduleTimeoutId) {
            GLib.source_remove(this._scheduleTimeoutId);
            this._scheduleTimeoutId = null;
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

        // Disconnect monitors-changed signal
        if (this._monitorsChangedId) {
            const monitorManager = global.backend.get_monitor_manager();
            monitorManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = null;
        }

        // Unsubscribe from suspend/resume signals
        if (this._suspendSignalId) {
            Gio.DBus.system.signal_unsubscribe(this._suspendSignalId);
            this._suspendSignalId = null;
        }

        // Disconnect all settings change signals
        const settingsSignals = [
            '_light_mode_triggerChangedId',
            '_dark_mode_triggerChangedId',
            '_custom_light_timeChangedId',
            '_custom_dark_timeChangedId',
            '_manual_latitudeChangedId',
            '_manual_longitudeChangedId',
            '_controlBrightnessChangedId',
            '_trueLightModeChangedId',
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

        // Clean up all references
        this._solarCalculator = null;
        this._settings = null;
        this._debugInfo = null;
        this._lightTime = null;
        this._darkTime = null;
        this._timeCalculator = null;
        this._extension = null;
    }

    _scheduleNextChangeEvent() {
        // Clear existing schedule timeout
        if (this._scheduleTimeoutId) {
            GLib.source_remove(this._scheduleTimeoutId);
            this._scheduleTimeoutId = null;
        }

        const now = new Date();
        const latitude = this._settings.get_string('manual-latitude');
        const longitude = this._settings.get_string('manual-longitude');

        let lightTime, darkTime, solarTimes = null;
        let lightModeTrigger, darkModeTrigger;

        // Check if coordinates are set and valid
        const hasCoordinates = latitude && longitude &&
            this._solarCalculator.validateCoordinates(latitude, longitude);

        if (hasCoordinates) {
            // Calculate solar times locally - no API calls needed!
            solarTimes = this._solarCalculator.getSolarTimes(now, latitude, longitude);

            if (solarTimes) {
                lightModeTrigger = this._settings.get_string('light-mode-trigger');
                lightTime = this._timeCalculator.parseTriggerTime(lightModeTrigger, solarTimes, now, 'light', this._settings);

                darkModeTrigger = this._settings.get_string('dark-mode-trigger');
                darkTime = this._timeCalculator.parseTriggerTime(darkModeTrigger, solarTimes, now, 'dark', this._settings);
            }
        }

        // Fall back to custom times if no coordinates or solar calculation failed
        if (!lightTime || !darkTime) {
            const customLightTime = this._settings.get_string('custom-light-time');
            const customDarkTime = this._settings.get_string('custom-dark-time');

            lightTime = this._timeCalculator.parseCustomTime(customLightTime, now);
            darkTime = this._timeCalculator.parseCustomTime(customDarkTime, now);
            lightModeTrigger = 'custom';
            darkModeTrigger = 'custom';

            if (!hasCoordinates) {
                console.log('ThemeSwitcher: No coordinates set, using custom times');
            }
        }

        if (!lightTime || !darkTime) {
            console.error('ThemeSwitcher: Failed to determine switch times');
            return;
        }

        this._lightTime = lightTime;
        this._darkTime = darkTime;

        // Update brightness controller with new times
        this._brightnessController.setTimes(lightTime, darkTime);
        this._brightnessController.scheduleBrightnessUpdates();

        // Store debug info
        this._storeDebugInfo(now, lightTime, darkTime, lightModeTrigger, darkModeTrigger, solarTimes);

        // Determine current mode and next event
        let nextEventTime, switchToDark;
        if (now >= darkTime || now < lightTime) {
            this._themeController.switchTheme(true, true, this._manualModeActive);
            // Only apply static brightness if NOT in a transition window
            // The scheduled brightness loop handles gradual transitions
            if (!this._brightnessController.isInTransitionWindow()) {
                this._brightnessController.updateBrightness(true).catch(e => {
                    console.error('ExtensionController: Failed to update brightness on initial schedule:', e);
                });
            }
            switchToDark = false;
            if (now < lightTime) {
                nextEventTime = lightTime;
            } else {
                nextEventTime = new Date(lightTime.getTime() + MS_PER_DAY);
            }
            this._debugInfo.currentMode = 'night';
        } else {
            this._themeController.switchTheme(false, true, this._manualModeActive);
            // Only apply static brightness if NOT in a transition window
            // The scheduled brightness loop handles gradual transitions
            if (!this._brightnessController.isInTransitionWindow()) {
                this._brightnessController.updateBrightness(true).catch(e => {
                    console.error('ExtensionController: Failed to update brightness on initial schedule:', e);
                });
            }
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
            // Apply brightness at theme switch time (this is the END of a transition, not during)
            // At switch time, we should apply the target brightness (light or dark)
            this._brightnessController.updateBrightness(true).catch(e => {
                console.error('ExtensionController: Failed to update brightness on scheduled event:', e);
            });
            this._scheduleNextChangeEvent();
            return GLib.SOURCE_REMOVE;
        });

        // Note: brightness is already applied above in the day/night block.
        // For external monitors that aren't ready yet at startup,
        // the monitors-changed signal handler will re-apply brightness
        // once Mutter finishes initializing them.
    }

    _storeDebugInfo(now, lightTime, darkTime, lightTrigger, darkTrigger, solarTimes) {
        const controlBrightness = this._settings.get_boolean('control-brightness');

        const lastUpdateStr = this._settings.get_string('last-brightness-update');
        const lastUpdateTimestamp = parseInt(lastUpdateStr, 10) || 0;

        let brightnessInfo = {
            enabled: controlBrightness,
            monitors: [],
            brightnessState: 'N/A',
            nextTransition: 'N/A',
            lastUpdateTimestamp: lastUpdateTimestamp,
        };

        if (controlBrightness) {
            // Load all enabled and initialized monitors (even if we can't calculate current brightness)
            try {
                const monitorsJson = this._settings.get_string('monitors');
                const monitors = JSON.parse(monitorsJson);
                const enabledMonitors = monitors.filter(m => m.enabled && m.initialized);

                // Sort monitors: built-in first, then external monitors
                enabledMonitors.sort((a, b) => {
                    if (a.id === 'builtin') return -1;
                    if (b.id === 'builtin') return 1;
                    return 0;
                });

                // Calculate brightness info for each monitor
                for (const monitor of enabledMonitors) {
                    const { lightBrightness, darkBrightness, name } = monitor;

                    if (lightBrightness === null || darkBrightness === null) {
                        continue; // Skip monitors without brightness values
                    }

                    let currentBrightness = null;

                    // Only calculate current brightness if we have time data
                    if (lightTime && darkTime) {
                        const decreaseDuration = this._settings.get_int('gradual-brightness-decrease-duration');
                        const increaseDuration = this._settings.get_int('gradual-brightness-increase-duration');

                        currentBrightness = this._brightnessController.calculateBrightness(
                            now, lightBrightness, darkBrightness, increaseDuration, decreaseDuration
                        );
                    }

                    brightnessInfo.monitors.push({
                        name: name,
                        lightBrightness: `${lightBrightness}%`,
                        darkBrightness: `${darkBrightness}%`,
                        currentBrightness: currentBrightness !== null ? `${currentBrightness}%` :
                            (lightTime && darkTime ? 'N/A' : 'Waiting for location data'),
                    });
                }

                // Calculate overall brightness state and next transition
                if (enabledMonitors.length > 0 && lightTime && darkTime) {
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
                                brightnessState = `Dimming (${progress}% through transition)`;
                                nextTransition = 'In transition';
                            } else {
                                brightnessState = 'Static brightness';
                                nextTransition = 'N/A';
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
                                brightnessState = `Brightening (${progress}% through transition)`;
                                nextTransition = 'In transition';
                            } else {
                                brightnessState = 'Static brightness';
                                nextTransition = 'N/A';
                            }
                        } else {
                            brightnessState = 'Not in adjustment window (gradual increase disabled)';
                            nextTransition = 'N/A';
                        }
                    }

                    brightnessInfo.brightnessState = brightnessState;
                    brightnessInfo.nextTransition = nextTransition;
                }
            } catch (e) {
                console.warn('Failed to load monitor brightness settings for debug info:', e);
            }
        }

        const latitude = this._settings.get_string('manual-latitude');
        const longitude = this._settings.get_string('manual-longitude');
        const locationName = this._settings.get_string('location-name');

        // Calculate tomorrow's solar times if we have coordinates
        let tomorrowSolarTimes = null;
        if (solarTimes && latitude && longitude) {
            const tomorrow = new Date(now);
            tomorrow.setDate(tomorrow.getDate() + 1);
            tomorrowSolarTimes = this._solarCalculator.getSolarTimes(tomorrow, latitude, longitude);
        }

        // Format date for display (e.g., "Mon, Dec 4")
        const formatDate = (date) => {
            return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
        };

        // Helper to format solar times object with date
        const formatSolarTimesWithDate = (times, date) => {
            if (!times) return null;
            return {
                date: formatDate(date),
                firstLight: times.first_light?.toLocaleTimeString() || 'N/A',
                nauticalDawn: times.nautical_dawn?.toLocaleTimeString() || 'N/A',
                dawn: times.dawn?.toLocaleTimeString() || 'N/A',
                sunrise: times.sunrise?.toLocaleTimeString() || 'N/A',
                sunriseEnd: times.sunrise_end?.toLocaleTimeString() || 'N/A',
                goldenHourEnd: times.golden_hour_end?.toLocaleTimeString() || 'N/A',
                solarNoon: times.solar_noon?.toLocaleTimeString() || 'N/A',
                goldenHour: times.golden_hour?.toLocaleTimeString() || 'N/A',
                sunsetStart: times.sunset_start?.toLocaleTimeString() || 'N/A',
                sunset: times.sunset?.toLocaleTimeString() || 'N/A',
                dusk: times.dusk?.toLocaleTimeString() || 'N/A',
                nauticalDusk: times.nautical_dusk?.toLocaleTimeString() || 'N/A',
                lastLight: times.last_light?.toLocaleTimeString() || 'N/A',
            };
        };

        // Helper to format solar times object (without date, for legacy compatibility)
        const formatSolarTimes = (times) => {
            if (!times) return null;
            return {
                firstLight: times.first_light?.toLocaleTimeString() || 'N/A',
                nauticalDawn: times.nautical_dawn?.toLocaleTimeString() || 'N/A',
                dawn: times.dawn?.toLocaleTimeString() || 'N/A',
                sunrise: times.sunrise?.toLocaleTimeString() || 'N/A',
                sunriseEnd: times.sunrise_end?.toLocaleTimeString() || 'N/A',
                goldenHourEnd: times.golden_hour_end?.toLocaleTimeString() || 'N/A',
                solarNoon: times.solar_noon?.toLocaleTimeString() || 'N/A',
                goldenHour: times.golden_hour?.toLocaleTimeString() || 'N/A',
                sunsetStart: times.sunset_start?.toLocaleTimeString() || 'N/A',
                sunset: times.sunset?.toLocaleTimeString() || 'N/A',
                dusk: times.dusk?.toLocaleTimeString() || 'N/A',
                nauticalDusk: times.nautical_dusk?.toLocaleTimeString() || 'N/A',
                lastLight: times.last_light?.toLocaleTimeString() || 'N/A',
            };
        };

        // Calculate tomorrow's date
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);

        const existingDebugInfo = this._debugInfo || {};

        this._debugInfo = {
            // Today's solar times with date
            solarTimesToday: formatSolarTimesWithDate(solarTimes, now),
            // Tomorrow's solar times with date
            solarTimesTomorrow: formatSolarTimesWithDate(tomorrowSolarTimes, tomorrow),
            // Keep legacy solarTimes for backward compatibility
            solarTimes: formatSolarTimes(solarTimes),
            currentTime: now.toLocaleString(),
            lightTime: lightTime ? lightTime.toLocaleString() : 'N/A',
            darkTime: darkTime ? darkTime.toLocaleString() : 'N/A',
            lightModeTrigger: lightTrigger,
            darkModeTrigger: darkTrigger,
            currentMode: existingDebugInfo.currentMode || 'N/A',
            nextEventTime: existingDebugInfo.nextEventTime || 'N/A',
            secondsToNextEvent: existingDebugInfo.secondsToNextEvent || 0,
            nextEventType: existingDebugInfo.nextEventType || 'N/A',
            latitude: latitude || 'Not set',
            longitude: longitude || 'Not set',
            locationName: locationName || 'Not set',
            timezone: this._solarCalculator.getTimezone(),
            calculationMethod: solarTimes ? 'Solar events (local calculation)' : 'Custom times',
            brightness: brightnessInfo,
        };
    }
}
