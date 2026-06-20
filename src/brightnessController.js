import GLib from 'gi://GLib';
import {
    MIN_BRIGHTNESS_UPDATE_INTERVAL_SECONDS,
    DEFAULT_BRIGHTNESS_UPDATE_INTERVAL_SECONDS,
    MS_PER_SECOND,
    MS_PER_DAY
} from './constants.js';
import {
    DdcutilDisplay,
    BrightnessCtlDisplay,
    MutterBacklightDisplay,
    isMutterBacklightAvailable
} from './displayController.js';

export class BrightnessController {
    constructor(settings) {
        this._settings = settings;
        this._brightnessTimeoutId = null;
        this._lastBrightnessUpdateTime = null;
        this._lightTime = null;
        this._darkTime = null;
        this._controllerCache = new Map(); // Cache DisplayController instances

        // Check if native Mutter backlight API is available (GNOME 49+)
        // This check is cached since it won't change during runtime
        this._useMutterBacklight = isMutterBacklightAvailable();
        if (this._useMutterBacklight) {
            console.log('BrightnessController: Using native Mutter backlight API (GNOME 49+)');
        } else {
            console.log('BrightnessController: Using legacy brightness control (brightnessctl/ddcutil)');
        }

        // Listen for monitor config changes to invalidate cache
        this._monitorsChangedId = this._settings.connect('changed::monitors', () => {
            this._invalidateControllerCache();
        });
    }

    setTimes(lightTime, darkTime) {
        this._lightTime = lightTime;
        this._darkTime = darkTime;
    }

    /**
     * Load all enabled and initialized monitors from settings.
     * @returns {Array} Array of enabled monitor objects
     * @private
     */
    _loadEnabledMonitors() {
        try {
            const json = this._settings.get_string('monitors');
            const monitors = JSON.parse(json);
            return monitors.filter(m => m.enabled && m.initialized);
        } catch (e) {
            console.warn('BrightnessController: Failed to load monitors:', e);
            return [];
        }
    }

    /**
     * Get or create a DisplayController for a monitor.
     * Controllers are cached for performance.
     * On GNOME 49+, uses native Mutter backlight API for all monitors.
     * On older versions, falls back to brightnessctl/ddcutil.
     * @param {Object} monitor - Monitor object
     * @returns {DisplayController} Controller instance
     * @private
     */
    _getOrCreateController(monitor) {
        if (!this._controllerCache.has(monitor.id)) {
            let controller;

            if (this._useMutterBacklight) {
                // GNOME 49+: Use native Mutter backlight API for all monitors
                controller = new MutterBacklightDisplay({
                    id: monitor.id,
                    name: monitor.name,
                    displayName: monitor.name // Use stored name to find monitor
                }, this._settings);
                console.log(`BrightnessController: Created Mutter controller for ${monitor.name}`);
            } else if (monitor.type === 'brightnessctl') {
                // Legacy: Built-in display via brightnessctl
                controller = new BrightnessCtlDisplay(this._settings);
                console.log(`BrightnessController: Created brightnessctl controller for ${monitor.name}`);
            } else {
                // Legacy: External monitor via ddcutil
                controller = new DdcutilDisplay(monitor, this._settings);
                console.log(`BrightnessController: Created ddcutil controller for ${monitor.name}`);
            }

            this._controllerCache.set(monitor.id, controller);
        }
        return this._controllerCache.get(monitor.id);
    }

    /**
     * Invalidate the controller cache when monitor settings change.
     * @private
     */
    _invalidateControllerCache() {
        console.log('BrightnessController: Invalidating controller cache due to settings change');
        this._controllerCache.clear();
    }

    async checkBrightnessctlAvailable() {
        try {
            const path = GLib.find_program_in_path('brightnessctl');
            return path !== null;
        } catch (e) {
            return false;
        }
    }

    async scheduleBrightnessUpdates() {
        // Clear any existing brightness timer
        if (this._brightnessTimeoutId) {
            GLib.source_remove(this._brightnessTimeoutId);
            this._brightnessTimeoutId = null;
        }

        const controlBrightness = this._settings.get_boolean('control-brightness');
        if (!controlBrightness) {
            console.log('BrightnessController: Brightness control disabled, not scheduling updates');
            return;
        }

        // For GNOME 49+, we use native Mutter API - no external tool check needed
        // For older versions, check if brightnessctl is available
        if (!this._useMutterBacklight) {
            const isBrightnessctlAvailable = await this.checkBrightnessctlAvailable();
            if (!isBrightnessctlAvailable) {
                console.log('BrightnessController: brightnessctl not available, not scheduling updates');
                return;
            }
        }

        if (!this._lightTime || !this._darkTime) {
            console.log('BrightnessController: Light/dark times not set, not scheduling updates');
            return;
        }

        const now = new Date();
        const gradualDecreaseEnabled = this._settings.get_boolean('gradual-brightness-decrease-enabled');
        const gradualIncreaseEnabled = this._settings.get_boolean('gradual-brightness-increase-enabled');

        if (!gradualDecreaseEnabled && !gradualIncreaseEnabled) {
            console.log('BrightnessController: Both gradual adjustments disabled, not scheduling updates');
            return;
        }

        const decreaseDuration = this._settings.get_int('gradual-brightness-decrease-duration') * MS_PER_SECOND;
        const increaseDuration = this._settings.get_int('gradual-brightness-increase-duration') * MS_PER_SECOND;

        // Calculate when the next adjustment window starts
        const inDayPeriod = now >= this._lightTime && now < this._darkTime;
        let nextWindowStart;
        let nextWindowEnd;
        let windowDurationMs;

        if (inDayPeriod) {
            if (gradualDecreaseEnabled) {
                const dimStartTime = new Date(this._darkTime.getTime() - decreaseDuration);
                if (now < dimStartTime) {
                    nextWindowStart = dimStartTime;
                    nextWindowEnd = this._darkTime;
                    windowDurationMs = decreaseDuration;
                } else if (now < this._darkTime) {
                    nextWindowStart = now;
                    nextWindowEnd = this._darkTime;
                    windowDurationMs = decreaseDuration;
                } else {
                    nextWindowStart = null;
                }
            } else {
                nextWindowStart = null;
            }
        } else {
            if (gradualIncreaseEnabled) {
                let nextLightTime = this._lightTime;
                if (now >= this._darkTime) {
                    nextLightTime = new Date(this._lightTime.getTime() + MS_PER_DAY);
                }

                const brightenStartTime = new Date(nextLightTime.getTime() - increaseDuration);
                if (now < brightenStartTime) {
                    nextWindowStart = brightenStartTime;
                    nextWindowEnd = nextLightTime;
                    windowDurationMs = increaseDuration;
                } else if (now < nextLightTime) {
                    nextWindowStart = now;
                    nextWindowEnd = nextLightTime;
                    windowDurationMs = increaseDuration;
                } else {
                    nextWindowStart = null;
                }
            } else {
                nextWindowStart = null;
            }
        }

        // If no window found, check the next period
        if (!nextWindowStart) {
            if (inDayPeriod && gradualIncreaseEnabled) {
                const tomorrowLightTime = new Date(this._lightTime.getTime() + MS_PER_DAY);
                nextWindowStart = new Date(tomorrowLightTime.getTime() - increaseDuration);
                nextWindowEnd = tomorrowLightTime;
                windowDurationMs = increaseDuration;
            } else if (!inDayPeriod && gradualDecreaseEnabled) {
                const nextDarkTime = now >= this._darkTime ?
                    new Date(this._darkTime.getTime() + MS_PER_DAY) :
                    this._darkTime;
                nextWindowStart = new Date(nextDarkTime.getTime() - decreaseDuration);
                nextWindowEnd = nextDarkTime;
                windowDurationMs = decreaseDuration;
            } else {
                return;
            }
        }

        const secondsUntilWindowStart = Math.max(0, Math.round((nextWindowStart.getTime() - now.getTime()) / MS_PER_SECOND));

        if (secondsUntilWindowStart > 0) {
            const hours = Math.floor(secondsUntilWindowStart / 3600);
            const minutes = Math.floor((secondsUntilWindowStart % 3600) / 60);
            console.log(`BrightnessController: Scheduling brightness update loop to start in ${hours}h ${minutes}m`);
            this._brightnessTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, secondsUntilWindowStart, () => {
                this._startBrightnessUpdateLoop(nextWindowEnd, windowDurationMs);
                return GLib.SOURCE_REMOVE;
            });
        } else {
            console.log('BrightnessController: Starting brightness update loop immediately (already in window)');
            this._startBrightnessUpdateLoop(nextWindowEnd, windowDurationMs);
        }
    }

    _startBrightnessUpdateLoop(windowEnd, windowDurationMs) {
        // Calculate optimal update interval for smooth transitions
        const updateIntervalSeconds = this._calculateUpdateInterval(windowDurationMs);

        console.log(`BrightnessController: Starting update loop (window ends at ${windowEnd.toLocaleString()}, interval=${updateIntervalSeconds}s)`);

        // Update immediately (fire-and-forget async)
        this.updateBrightness().catch(e => {
            console.error('BrightnessController: Error during initial update:', e);
        });

        // Clear any existing timer
        if (this._brightnessTimeoutId) {
            console.log('BrightnessController: Removing existing timer before starting new loop');
            GLib.source_remove(this._brightnessTimeoutId);
            this._brightnessTimeoutId = null;
        }

        // Schedule updates at the calculated interval until window ends
        this._brightnessTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, updateIntervalSeconds, () => {
            const now = new Date();

            if (now >= windowEnd) {
                // Window has ended - schedule next window AFTER this timer is fully cleaned up
                console.log('BrightnessController: Update window ended, stopping timer and rescheduling');
                // Use idle_add to defer the rescheduling until the next event loop iteration
                this._brightnessTimeoutId = null; // Clear immediately to prevent double-removal
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    this.scheduleBrightnessUpdates();
                    return GLib.SOURCE_REMOVE;
                });
                return GLib.SOURCE_REMOVE;
            }

            // Fire-and-forget async update
            this.updateBrightness().catch(e => {
                console.error('BrightnessController: Error during scheduled update:', e);
            });
            return GLib.SOURCE_CONTINUE;
        });
        console.log(`BrightnessController: Timer scheduled with ID ${this._brightnessTimeoutId}`);
    }

    /**
     * Calculate the optimal update interval for smooth brightness transitions.
     * Each step should change brightness by ~1% for the monitor with the largest range.
     * @param {number} windowDurationMs - Total transition window duration in milliseconds
     * @returns {number} Update interval in seconds
     * @private
     */
    _calculateUpdateInterval(windowDurationMs) {
        const monitors = this._loadEnabledMonitors();

        if (monitors.length === 0) {
            return DEFAULT_BRIGHTNESS_UPDATE_INTERVAL_SECONDS;
        }

        // Find the largest brightness delta across all monitors
        let maxDelta = 0;
        for (const monitor of monitors) {
            if (monitor.lightBrightness !== null && monitor.darkBrightness !== null) {
                const delta = Math.abs(monitor.lightBrightness - monitor.darkBrightness);
                maxDelta = Math.max(maxDelta, delta);
            }
        }

        if (maxDelta === 0) {
            return DEFAULT_BRIGHTNESS_UPDATE_INTERVAL_SECONDS;
        }

        // interval = totalDuration / numberOfSteps, where each step is ~1% brightness
        const windowDurationSeconds = windowDurationMs / MS_PER_SECOND;
        const interval = windowDurationSeconds / maxDelta;

        return Math.max(MIN_BRIGHTNESS_UPDATE_INTERVAL_SECONDS, Math.round(interval));
    }

    /**
     * Update brightness for all enabled monitors.
     * Monitors are updated in parallel for performance.
     * @param {boolean} allowStaticBrightness - If true, apply static light/dark brightness outside transition windows
     */
    async updateBrightness(allowStaticBrightness = false) {
        console.log(`BrightnessController: updateBrightness called (allowStaticBrightness=${allowStaticBrightness})`);

        const controlBrightness = this._settings.get_boolean('control-brightness');
        if (!controlBrightness || !this._lightTime || !this._darkTime) {
            console.log('BrightnessController: Skipping update - control disabled or times not set');
            return;
        }

        // Load all enabled monitors
        const monitors = this._loadEnabledMonitors();
        if (monitors.length === 0) {
            console.log('BrightnessController: Skipping update - no enabled monitors');
            return; // No monitors to update
        }

        const now = new Date();
        console.log(`BrightnessController: Updating ${monitors.length} monitor(s) at ${now.toLocaleString()}`);

        // Read global duration settings (same for all monitors in this release)
        const globalIncreaseDuration = this._settings.get_int('gradual-brightness-increase-duration');
        const globalDecreaseDuration = this._settings.get_int('gradual-brightness-decrease-duration');

        // Update all monitors in parallel
        const updatePromises = monitors.map(monitor =>
            this._updateSingleMonitor(monitor, now, allowStaticBrightness,
                                      globalIncreaseDuration, globalDecreaseDuration)
        );

        // Wait for all updates to complete (or fail)
        const results = await Promise.allSettled(updatePromises);

        // Log any failures
        const failures = results.filter(r => r.status === 'rejected');
        if (failures.length > 0) {
            console.warn(`BrightnessController: ${failures.length} monitor(s) failed to update`);
        }

        // Update timestamp after successful updates
        const successCount = results.filter(r => r.status === 'fulfilled').length;
        if (successCount > 0) {
            this._lastBrightnessUpdateTime = now.getTime();
            this._settings.set_string('last-brightness-update', this._lastBrightnessUpdateTime.toString());
        }
    }

    /**
     * Update brightness for a single monitor.
     * @param {Object} monitor - Monitor configuration object
     * @param {Date} now - Current time
     * @param {boolean} allowStaticBrightness - Whether to apply static brightness outside transitions
     * @param {number} globalIncreaseDuration - Global increase duration in seconds
     * @param {number} globalDecreaseDuration - Global decrease duration in seconds
     * @private
     */
    async _updateSingleMonitor(monitor, now, allowStaticBrightness,
                               globalIncreaseDuration, globalDecreaseDuration) {
        const { lightBrightness, darkBrightness } = monitor;

        if (lightBrightness === null || darkBrightness === null) {
            return; // Skip monitors without brightness values
        }

        // Use monitor's own durations if available, otherwise use global
        // (For this release, we copy global values to all monitors, but this keeps it flexible)
        const increaseDuration = monitor.increaseDuration ?? globalIncreaseDuration;
        const decreaseDuration = monitor.decreaseDuration ?? globalDecreaseDuration;

        // Calculate target brightness for this monitor
        const transitionalBrightness = this.calculateBrightness(
            now, lightBrightness, darkBrightness,
            increaseDuration, decreaseDuration
        );

        let targetBrightness;
        if (transitionalBrightness !== null) {
            console.log(`BrightnessController: ${monitor.name} - in transition, target=${transitionalBrightness}%`);
            targetBrightness = transitionalBrightness;
        } else if (allowStaticBrightness) {
            const inDayPeriod = now >= this._lightTime && now < this._darkTime;
            targetBrightness = inDayPeriod ? lightBrightness : darkBrightness;
            console.log(`BrightnessController: ${monitor.name} - static brightness allowed, target=${targetBrightness}%`);
        } else {
            console.log(`BrightnessController: ${monitor.name} - not in transition and static not allowed, skipping`);
            return; // Not in transition window and static not allowed
        }

        // Apply brightness using cached controller
        try {
            const controller = this._getOrCreateController(monitor);
            const success = await controller.setBrightness(targetBrightness);

            if (!success) {
                // setBrightness returned false (e.g. monitor not found in Mutter)
                monitor.consecutiveFailures = (monitor.consecutiveFailures || 0) + 1;
                console.warn(`BrightnessController: ${monitor.name} not available (failure #${monitor.consecutiveFailures})`);
                throw new Error(`Monitor ${monitor.name} not available`);
            }

            console.log(`BrightnessController: Updated ${monitor.name} to ${targetBrightness}%`);

            // Reset failure counter on success
            if (monitor.consecutiveFailures) {
                monitor.consecutiveFailures = 0;
            }
        } catch (e) {
            // Track consecutive failures (may already be incremented above)
            if (!monitor.consecutiveFailures) {
                monitor.consecutiveFailures = (monitor.consecutiveFailures || 0) + 1;
            }
            console.warn(`BrightnessController: Failed to update ${monitor.name} (failure #${monitor.consecutiveFailures}): ${e.message}`);

            if (monitor.consecutiveFailures >= 3) {
                console.warn(`BrightnessController: ${monitor.name} has failed ${monitor.consecutiveFailures} times - monitor may be unplugged`);
            }

            // Re-throw to mark this promise as rejected
            throw e;
        }
    }

    /**
     * Calculate transitional brightness based on time of day.
     * @param {Date} now - Current time
     * @param {number} lightBrightness - Target brightness during light mode
     * @param {number} darkBrightness - Target brightness during dark mode
     * @param {number} increaseDuration - Duration in seconds for brightness increase
     * @param {number} decreaseDuration - Duration in seconds for brightness decrease
     * @returns {number|null} Calculated brightness (1-100) or null if not in transition window
     */
    calculateBrightness(now, lightBrightness, darkBrightness, increaseDuration, decreaseDuration) {
        const lightTime = this._lightTime;
        const darkTime = this._darkTime;

        const gradualDecreaseEnabled = this._settings.get_boolean('gradual-brightness-decrease-enabled');
        const gradualIncreaseEnabled = this._settings.get_boolean('gradual-brightness-increase-enabled');

        // Convert durations to milliseconds
        const decreaseDurationMs = decreaseDuration * MS_PER_SECOND;
        const increaseDurationMs = increaseDuration * MS_PER_SECOND;

        let inDayPeriod = now >= lightTime && now < darkTime;

        if (now >= darkTime || now < lightTime) {
            inDayPeriod = false;
        }

        if (inDayPeriod) {
            if (gradualDecreaseEnabled) {
                const dimStartTime = new Date(darkTime.getTime() - decreaseDurationMs);

                if (now >= dimStartTime && now < darkTime) {
                    const elapsed = now.getTime() - dimStartTime.getTime();
                    const progress = elapsed / decreaseDurationMs;
                    const brightness = lightBrightness + (darkBrightness - lightBrightness) * progress;
                    return Math.round(Math.max(1, Math.min(100, brightness)));
                } else {
                    return null;
                }
            } else {
                return null;
            }
        } else {
            let nextLightTime = lightTime;
            if (now >= darkTime) {
                nextLightTime = new Date(lightTime.getTime() + MS_PER_DAY);
            }

            if (gradualIncreaseEnabled) {
                const brightenStartTime = new Date(nextLightTime.getTime() - increaseDurationMs);

                if (now >= brightenStartTime && now < nextLightTime) {
                    const elapsed = now.getTime() - brightenStartTime.getTime();
                    const progress = elapsed / increaseDurationMs;
                    const brightness = darkBrightness + (lightBrightness - darkBrightness) * progress;
                    return Math.round(Math.max(1, Math.min(100, brightness)));
                } else {
                    return null;
                }
            } else {
                return null;
            }
        }
    }

    /**
     * Check if currently in a brightness transition window.
     * @returns {boolean} True if in a transition window
     */
    isInTransitionWindow() {
        if (!this._lightTime || !this._darkTime) {
            return false;
        }

        const now = new Date();
        const gradualDecreaseEnabled = this._settings.get_boolean('gradual-brightness-decrease-enabled');
        const gradualIncreaseEnabled = this._settings.get_boolean('gradual-brightness-increase-enabled');
        const decreaseDuration = this._settings.get_int('gradual-brightness-decrease-duration') * MS_PER_SECOND;
        const increaseDuration = this._settings.get_int('gradual-brightness-increase-duration') * MS_PER_SECOND;

        const inDayPeriod = now >= this._lightTime && now < this._darkTime;

        if (inDayPeriod && gradualDecreaseEnabled) {
            const dimStartTime = new Date(this._darkTime.getTime() - decreaseDuration);
            if (now >= dimStartTime && now < this._darkTime) {
                return true;
            }
        } else if (!inDayPeriod && gradualIncreaseEnabled) {
            let nextLightTime = this._lightTime;
            if (now >= this._darkTime) {
                nextLightTime = new Date(this._lightTime.getTime() + MS_PER_DAY);
            }
            const brightenStartTime = new Date(nextLightTime.getTime() - increaseDuration);
            if (now >= brightenStartTime && now < nextLightTime) {
                return true;
            }
        }

        return false;
    }

    cleanup() {
        // Remove any active timers
        if (this._brightnessTimeoutId) {
            GLib.source_remove(this._brightnessTimeoutId);
            this._brightnessTimeoutId = null;
        }

        // Disconnect settings signal
        if (this._monitorsChangedId && this._settings) {
            this._settings.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = null;
        }

        // Clear controller cache
        this._controllerCache.clear();

        // Clear all state to prevent memory leaks
        this._settings = null;
        this._lastBrightnessUpdateTime = null;
        this._lightTime = null;
        this._darkTime = null;
    }
}
