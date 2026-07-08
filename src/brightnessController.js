import GLib from 'gi://GLib';
import {
    MIN_BRIGHTNESS_UPDATE_INTERVAL_SECONDS,
    DEFAULT_BRIGHTNESS_UPDATE_INTERVAL_SECONDS,
    MS_PER_SECOND,
    MS_PER_DAY
} from './constants.js';
import { probeDisplayController } from './displayController.js';
import { debugLog, debugWarn } from './logger.js';

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

        // Per-monitor ramp anchor, keyed by monitor.id: the ACTUAL brightness the
        // display was at when the current transition window started. Gradual
        // transitions interpolate anchor -> target instead of configured-endpoint
        // -> target, so a manual brightness change made during the day/night
        // doesn't get snapped back to the configured value at window start.
        this._transitionAnchors = new Map();

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
            debugWarn('BrightnessController: Failed to load monitors:', e);
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
        debugLog('BrightnessController: Invalidating controller cache due to settings change');
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
        this._transitionAnchors.clear();

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
                debugLog(`BrightnessController: manual mode — ${monitor.name} already at ${target}%, skipping write`);
                return;
            }

            try {
                const controller = await this._getOrCreateController(monitor);
                const success = await controller.setBrightness(target);
                if (success) {
                    this._lastAppliedBrightness.set(monitor.id, target);
                    debugLog(`BrightnessController: manual ${isDark ? 'dark' : 'light'} mode — set ${monitor.name} to ${target}%`);
                } else {
                    debugWarn(`BrightnessController: manual mode — ${monitor.name} setBrightness returned false`);
                }
            } catch (e) {
                debugWarn(`BrightnessController: manual mode — failed to set ${monitor.name}: ${e.message || e}`);
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
            debugLog('BrightnessController: Brightness control disabled, not scheduling updates');
            return;
        }

        if (!this._lightTime || !this._darkTime) {
            debugLog('BrightnessController: Light/dark times not set, not scheduling updates');
            return;
        }

        const now = new Date();
        const gradualDecreaseEnabled = this._settings.get_boolean('gradual-brightness-decrease-enabled');
        const gradualIncreaseEnabled = this._settings.get_boolean('gradual-brightness-increase-enabled');

        if (!gradualDecreaseEnabled && !gradualIncreaseEnabled) {
            debugLog('BrightnessController: Both gradual adjustments disabled, not scheduling updates');
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
            debugLog(`BrightnessController: Scheduling brightness update loop to start in ${hours}h ${minutes}m`);
            this._brightnessTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, secondsUntilWindowStart, () => {
                this._startBrightnessUpdateLoop(nextWindowEnd, windowDurationMs);
                return GLib.SOURCE_REMOVE;
            });
        } else {
            debugLog('BrightnessController: Starting brightness update loop immediately (already in window)');
            this._startBrightnessUpdateLoop(nextWindowEnd, windowDurationMs);
        }
    }

    _startBrightnessUpdateLoop(windowEnd, windowDurationMs) {
        // Calculate optimal update interval for smooth transitions
        const updateIntervalSeconds = this._calculateUpdateInterval(windowDurationMs);

        debugLog(`BrightnessController: Starting update loop (window ends at ${windowEnd.toLocaleString()}, interval=${updateIntervalSeconds}s)`);

        // Anchor the ramp at each monitor's ACTUAL brightness before the first
        // write, then update (fire-and-forget async). If the user manually
        // changed brightness since the last static apply, the transition starts
        // from that value instead of snapping to the configured endpoint.
        this._captureTransitionAnchors()
            .then(() => this.updateBrightness())
            .catch(e => {
                console.error('BrightnessController: Error during initial update:', e);
            });

        // Clear any existing timer
        if (this._brightnessTimeoutId) {
            debugLog('BrightnessController: Removing existing timer before starting new loop');
            GLib.source_remove(this._brightnessTimeoutId);
            this._brightnessTimeoutId = null;
        }

        // Schedule updates at the calculated interval until window ends
        this._brightnessTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, updateIntervalSeconds, () => {
            const now = new Date();

            if (now >= windowEnd) {
                // Window has ended - schedule next window AFTER this timer is fully cleaned up
                debugLog('BrightnessController: Update window ended, stopping timer and rescheduling');
                // Anchors are only meaningful within the window they were captured in
                this._transitionAnchors.clear();
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
        debugLog(`BrightnessController: Timer scheduled with ID ${this._brightnessTimeoutId}`);
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
        // Extension may have been disabled while an async chain was pending
        if (!this._settings) {
            return;
        }

        debugLog(`BrightnessController: updateBrightness called (allowStaticBrightness=${allowStaticBrightness})`);

        const controlBrightness = this._settings.get_boolean('control-brightness');
        if (!controlBrightness || !this._lightTime || !this._darkTime) {
            debugLog('BrightnessController: Skipping update - control disabled or times not set');
            return;
        }

        // Load all enabled monitors
        const monitors = this._loadEnabledMonitors();
        if (monitors.length === 0) {
            debugLog('BrightnessController: Skipping update - no enabled monitors');
            return; // No monitors to update
        }

        const now = new Date();
        debugLog(`BrightnessController: Updating ${monitors.length} monitor(s) at ${now.toLocaleString()}`);

        // Resolve the transition durations once — same global values the
        // scheduler uses, so the loop's math can't drift from the loop's timing.
        const { increaseDuration, decreaseDuration } = this._resolveDurations();

        // Update all monitors in parallel
        const updatePromises = monitors.map(monitor =>
            this._updateSingleMonitor(monitor, now, allowStaticBrightness,
                                      increaseDuration, decreaseDuration)
        );

        // Wait for all updates to complete (or fail)
        const results = await Promise.allSettled(updatePromises);

        // Log any failures
        const failures = results.filter(r => r.status === 'rejected');
        if (failures.length > 0) {
            debugWarn(`BrightnessController: ${failures.length} monitor(s) failed to update`);
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
     * @param {number} increaseDuration - Increase duration in seconds (global; see _resolveDurations)
     * @param {number} decreaseDuration - Decrease duration in seconds (global; see _resolveDurations)
     * @private
     */
    async _updateSingleMonitor(monitor, now, allowStaticBrightness,
                               increaseDuration, decreaseDuration) {
        const { lightBrightness, darkBrightness } = monitor;

        if (lightBrightness === null || darkBrightness === null) {
            return; // Skip monitors without brightness values
        }

        // Calculate target brightness for this monitor, ramping from the
        // anchor (actual brightness at window start) when one was captured
        const transitionalBrightness = this.calculateBrightness(
            now, lightBrightness, darkBrightness,
            increaseDuration, decreaseDuration,
            this.getTransitionAnchor(monitor.id)
        );

        let targetBrightness;
        if (transitionalBrightness !== null) {
            debugLog(`BrightnessController: ${monitor.name} - in transition, target=${transitionalBrightness}%`);
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
                debugWarn(`BrightnessController: ${monitor.name} - calc returned null while inside transition window, deferring to loop`);
                return;
            }
            const inDayPeriod = now >= this._lightTime && now < this._darkTime;
            targetBrightness = inDayPeriod ? lightBrightness : darkBrightness;
            debugLog(`BrightnessController: ${monitor.name} - static brightness allowed, target=${targetBrightness}%`);
        } else {
            debugLog(`BrightnessController: ${monitor.name} - not in transition and static not allowed, skipping`);
            return; // Not in transition window and static not allowed
        }

        // Skip the write if we already wrote this exact value last time. Saves DDC
        // EEPROM cycles and the ~200-500ms cost of the ddcutil subprocess on each
        // event-driven re-application (lock/unlock, monitors-changed, etc.).
        if (this._lastAppliedBrightness.get(monitor.id) === targetBrightness) {
            debugLog(`BrightnessController: ${monitor.name} already at ${targetBrightness}%, skipping write`);
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
                debugWarn(`BrightnessController: ${monitor.name} not available (failure #${monitor.consecutiveFailures})`);
                throw new Error(`Monitor ${monitor.name} not available`);
            }

            this._lastAppliedBrightness.set(monitor.id, targetBrightness);
            debugLog(`BrightnessController: Updated ${monitor.name} to ${targetBrightness}%`);

            // Reset failure counter on success
            if (monitor.consecutiveFailures) {
                monitor.consecutiveFailures = 0;
            }
        } catch (e) {
            // Track consecutive failures (may already be incremented above)
            if (!monitor.consecutiveFailures) {
                monitor.consecutiveFailures = (monitor.consecutiveFailures || 0) + 1;
            }
            debugWarn(`BrightnessController: Failed to update ${monitor.name} (failure #${monitor.consecutiveFailures}): ${e.message}`);

            if (monitor.consecutiveFailures >= 3) {
                debugWarn(`BrightnessController: ${monitor.name} has failed ${monitor.consecutiveFailures} times - monitor may be unplugged`);
            }

            // Re-throw to mark this promise as rejected
            throw e;
        }
    }

    /**
     * Resolve the gradual transition durations (in seconds) to use for the
     * brightness math. Always the GLOBAL settings — the same values
     * scheduleBrightnessUpdates() uses to decide when to start and stop the loop.
     *
     * The per-monitor `increaseDuration`/`decreaseDuration` fields are
     * intentionally ignored. They are a one-time snapshot copied from the global
     * default when a monitor is first detected (displayManager/migrationManager)
     * and nothing in the UI ever updates them. The old
     * `monitor.increaseDuration ?? global` fallback honored that stale snapshot,
     * which desynced calculateBrightness from the scheduler: after the user
     * lowered the global duration, the loop started at `lightTime - globalDuration`
     * but the ramp was computed over the longer stale per-monitor duration, so the
     * first tick jumped partway up the curve instead of starting at darkBrightness.
     *
     * @param {Object} [_monitor] - accepted for call-site symmetry; unused.
     * @returns {{increaseDuration: number, decreaseDuration: number}} durations in seconds
     * @private
     */
    _resolveDurations(_monitor) {
        return {
            increaseDuration: this._settings.get_int('gradual-brightness-increase-duration'),
            decreaseDuration: this._settings.get_int('gradual-brightness-decrease-duration'),
        };
    }

    /**
     * Read each enabled monitor's ACTUAL current brightness and store it as the
     * ramp anchor for the transition window that is starting. Failures are
     * per-monitor and non-fatal: a monitor without an anchor simply falls back
     * to the legacy configured-endpoint ramp in calculateBrightness().
     * @private
     */
    async _captureTransitionAnchors() {
        // Extension may have been disabled while this chain was pending
        if (!this._settings) {
            return;
        }

        this._transitionAnchors.clear();

        const monitors = this._loadEnabledMonitors();
        await Promise.allSettled(monitors.map(async monitor => {
            try {
                const controller = await this._getOrCreateController(monitor);
                const current = await controller.getBrightness();
                if (typeof current === 'number' && current >= 1 && current <= 100) {
                    this._transitionAnchors.set(monitor.id, current);
                    debugLog(`BrightnessController: ${monitor.name} - transition anchored at actual brightness ${current}%`);
                } else {
                    debugWarn(`BrightnessController: ${monitor.name} - could not read brightness for anchor, using configured endpoint`);
                }
            } catch (e) {
                debugWarn(`BrightnessController: ${monitor.name} - anchor read failed: ${e.message || e}`);
            }
        }));
    }

    /**
     * The ramp anchor captured for a monitor at the current window's start.
     * @param {string} monitorId - Monitor id from settings
     * @returns {number|null} Anchor brightness (1-100), or null if none captured
     */
    getTransitionAnchor(monitorId) {
        return this._transitionAnchors.get(monitorId) ?? null;
    }

    /**
     * Calculate transitional brightness based on time of day.
     *
     * When an anchor is given, the ramp runs anchor -> target so the transition
     * always starts from the brightness the screen is actually at (the user may
     * have moved the slider since the configured value was applied). Without an
     * anchor it falls back to configured-endpoint -> target.
     * @param {Date} now - Current time
     * @param {number} lightBrightness - Target brightness during light mode
     * @param {number} darkBrightness - Target brightness during dark mode
     * @param {number} increaseDuration - Duration in seconds for brightness increase
     * @param {number} decreaseDuration - Duration in seconds for brightness decrease
     * @param {number|null} [anchorBrightness] - Actual brightness at window start
     * @returns {number|null} Calculated brightness (1-100) or null if not in transition window
     */
    calculateBrightness(now, lightBrightness, darkBrightness, increaseDuration, decreaseDuration, anchorBrightness = null) {
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
                    const startBrightness = anchorBrightness ?? lightBrightness;
                    const brightness = startBrightness + (darkBrightness - startBrightness) * progress;
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
                    const startBrightness = anchorBrightness ?? darkBrightness;
                    const brightness = startBrightness + (lightBrightness - startBrightness) * progress;
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
        this._transitionAnchors.clear();

        // Clear all state to prevent memory leaks
        this._settings = null;
        this._lastBrightnessUpdateTime = null;
        this._lightTime = null;
        this._darkTime = null;
    }
}
