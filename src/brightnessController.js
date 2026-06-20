import GLib from 'gi://GLib';
import {
    MIN_BRIGHTNESS_UPDATE_INTERVAL_SECONDS,
    DEFAULT_BRIGHTNESS_UPDATE_INTERVAL_SECONDS,
    MS_PER_SECOND,
    MS_PER_DAY
} from './constants.js';
import { probeDisplayController } from './displayController.js';

export class BrightnessController {
    constructor(settings) {
        this._settings = settings;
        this._brightnessTimeoutId = null;
        this._lastBrightnessUpdateTime = null;
        this._lightTime = null;
        this._darkTime = null;
        // Per-monitor cache: monitor.id -> Promise<DisplayController>.
        // Storing promises lets concurrent probes for the same monitor share the result.
        this._controllerCache = new Map();

        // Per-monitor cache of the last brightness we successfully wrote, keyed by
        // monitor.id. Used to skip redundant setBrightness calls — important for
        // ddcutil monitors where each write is slow (~200-500ms) and persists to
        // EEPROM (limited write cycles). Without this, every lock/unlock or
        // monitors-changed event re-writes the same value.
        this._lastAppliedBrightness = new Map();

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
     * Get a DisplayController for a monitor, probing once and caching the result.
     * Backend selection is delegated to probeDisplayController() in
     * displayController.js so the shell side and prefs side stay in sync.
     *
     * The cache stores Promise<DisplayController> so concurrent calls for the
     * same monitor share a single probe rather than racing.
     * @param {Object} monitor - Monitor object from settings
     * @returns {Promise<DisplayController>} Resolved controller
     * @private
     */
    _getOrCreateController(monitor) {
        if (!this._controllerCache.has(monitor.id)) {
            this._controllerCache.set(monitor.id, probeDisplayController(monitor, this._settings));
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
        // Also drop the last-applied brightness cache. The user may have changed
        // their light/dark brightness values in prefs, which means our previous
        // "last applied" record no longer matches their intended target.
        this._lastAppliedBrightness.clear();
    }

    /**
     * Apply static brightness for a user-chosen manual mode and pause the
     * automatic time-based brightness loop. This is called from
     * ExtensionController.forceThemeSwitch and from the event handlers
     * (session mode change, screen unlock, monitors-changed) while manual
     * mode is active.
     *
     * Crucially this BYPASSES calculateBrightness — manual mode is
     * authoritative, the time-of-day target shouldn't override the user's
     * choice. The brightness loop is also cancelled so it doesn't fight us
     * on the next tick.
     * @param {boolean} isDark - true to apply darkBrightness, false for lightBrightness
     */
    async applyManualBrightness(isDark) {
        // Stop the automatic loop — manual overrides time-based logic.
        if (this._brightnessTimeoutId) {
            GLib.source_remove(this._brightnessTimeoutId);
            this._brightnessTimeoutId = null;
        }

        if (!this._settings.get_boolean('control-brightness')) {
            return;
        }

        const monitors = this._loadEnabledMonitors();
        if (monitors.length === 0) {
            return;
        }

        const updatePromises = monitors.map(async monitor => {
            const target = isDark ? monitor.darkBrightness : monitor.lightBrightness;
            if (target === null) return;

            if (this._lastAppliedBrightness.get(monitor.id) === target) {
                console.log(`BrightnessController: manual mode — ${monitor.name} already at ${target}%, skipping write`);
                return;
            }

            try {
                const controller = await this._getOrCreateController(monitor);
                const success = await controller.setBrightness(target);
                if (success) {
                    this._lastAppliedBrightness.set(monitor.id, target);
                    console.log(`BrightnessController: manual ${isDark ? 'dark' : 'light'} mode — set ${monitor.name} to ${target}%`);
                } else {
                    console.warn(`BrightnessController: manual mode — ${monitor.name} setBrightness returned false`);
                }
            } catch (e) {
                console.warn(`BrightnessController: manual mode — failed to set ${monitor.name}: ${e.message || e}`);
            }
        });

        await Promise.allSettled(updatePromises);
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
            // Defensive backstop: never apply static brightness while we're inside a
            // transition window, even if a caller mistakenly asks for it. The loop
            // owns brightness during transitions; a static write here would fight it
            // and historically caused "brightness snaps to lightBrightness every few
            // minutes" while the user was in the gradual brightening period. If
            // calculateBrightness returned null *during* a transition window, that's
            // an edge state (boundary, settings race) — better to defer to the next
            // loop tick than to write a wrong value.
            if (this.isInTransitionWindow()) {
                console.warn(`BrightnessController: ${monitor.name} - calc returned null while inside transition window, deferring to loop`);
                return;
            }
            const inDayPeriod = now >= this._lightTime && now < this._darkTime;
            targetBrightness = inDayPeriod ? lightBrightness : darkBrightness;
            console.log(`BrightnessController: ${monitor.name} - static brightness allowed, target=${targetBrightness}%`);
        } else {
            console.log(`BrightnessController: ${monitor.name} - not in transition and static not allowed, skipping`);
            return; // Not in transition window and static not allowed
        }

        // Skip the write if we already wrote this exact value last time. Saves DDC
        // EEPROM cycles and the ~200-500ms cost of the ddcutil subprocess on each
        // event-driven re-application (lock/unlock, monitors-changed, etc.).
        if (this._lastAppliedBrightness.get(monitor.id) === targetBrightness) {
            console.log(`BrightnessController: ${monitor.name} already at ${targetBrightness}%, skipping write`);
            if (monitor.consecutiveFailures) {
                monitor.consecutiveFailures = 0;
            }
            return;
        }

        // Apply brightness using cached controller
        try {
            const controller = await this._getOrCreateController(monitor);
            const success = await controller.setBrightness(targetBrightness);

            if (!success) {
                // setBrightness returned false (e.g. monitor not found in Mutter)
                monitor.consecutiveFailures = (monitor.consecutiveFailures || 0) + 1;
                console.warn(`BrightnessController: ${monitor.name} not available (failure #${monitor.consecutiveFailures})`);
                throw new Error(`Monitor ${monitor.name} not available`);
            }

            this._lastAppliedBrightness.set(monitor.id, targetBrightness);
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
        this._lastAppliedBrightness.clear();

        // Clear all state to prevent memory leaks
        this._settings = null;
        this._lastBrightnessUpdateTime = null;
        this._lightTime = null;
        this._darkTime = null;
    }
}
