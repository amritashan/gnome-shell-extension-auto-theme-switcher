import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import GLib from 'gi://GLib';

/**
 * Reusable brightness slider component with real-time preview functionality.
 *
 * This component provides:
 * - A slider for adjusting brightness (1-100%)
 * - Real-time preview: brightness changes as user drags the slider
 * - Automatic restore: original brightness is restored when slider is released
 * - Toast notifications: shows monitor-specific preview and restore messages
 *
 * Works with any DisplayController implementation (brightnessctl, ddcutil,
 * Mutter backlight, gnome-settings-daemon Power d-bus, etc.)
 *
 * ──────────────────────────────────────────────────────────────────────────
 * STALE-WRITE BUG WARNING — read before refactoring
 * ──────────────────────────────────────────────────────────────────────────
 * Every backend's setBrightness is async and slow (ddcutil can take seconds).
 * If multiple writes are issued during a drag without serialization, they can
 * complete out of order and the last one to land — possibly a stale value
 * issued during the drag — overwrites the restore. The screen is then stuck
 * at a preview brightness even though the slider was released.
 *
 * Four invariants prevent that, and refactors must preserve all four:
 *
 *   1. AT MOST ONE setBrightness IN FLIGHT.
 *      `brightnessInFlight` + `latestDesiredBrightness` form a "latest wins"
 *      queue (see _processNextBrightness). Never call setBrightness in
 *      parallel — newer slider values must overwrite the queued value, not
 *      spawn a second concurrent write.
 *
 *   2. RESTORE AWAITS IN-FLIGHT WRITES.
 *      _restoreOriginalBrightness clears latestDesiredBrightness, then
 *      `await`s `lastPreviewPromise` BEFORE issuing the restore call. If a
 *      future change moves the restore call earlier, a preview write can land
 *      after it and re-corrupt the screen.
 *
 *   3. ONE displayController INSTANCE PER SLIDER FOR ITS WHOLE LIFETIME.
 *      The in-flight promise tracking is per-instance. If you later swap to
 *      probing/dispatching controllers (e.g. via BrightnessController's
 *      _probeController) for slider previews too, you MUST resolve the
 *      controller once at construction and reuse it — don't re-probe per
 *      drag, and don't replace the controller mid-preview.
 *
 *   4. ORIGINAL CAPTURE COMPLETES BEFORE ANY PREVIEW WRITE.
 *      _processNextBrightness `await`s `brightnessQueryPromise` before issuing
 *      the first setBrightness. Without this gate, getBrightness and our own
 *      setBrightness can race on the same hardware channel (ddcutil's i2c/VCP,
 *      brightnessctl's sysfs) and the read can return our own preview write
 *      as the "original". The slider then restores to the preview value and
 *      the user is stuck at it. DO NOT reintroduce a `_previewStarted`-style
 *      flag that lets the .then run before the query finishes — serialize
 *      properly instead.
 *
 * Symptoms of regression: drop the slider thumb, screen stays at the preview
 * brightness; or screen flickers between values for a second or two after
 * release. If you see those, you've broken one of the four invariants above.
 * ──────────────────────────────────────────────────────────────────────────
 */
export class BrightnessSliderRow {
    /**
     * @param {string} title - Row title (e.g., "Light Mode Brightness")
     * @param {string} subtitle - Row subtitle (e.g., "Screen brightness during light mode (%)")
     * @param {string|null} settingsKey - GSettings key for storing this brightness value (null for manual handling)
     * @param {DisplayController} displayController - Controller for this display
     * @param {Adw.PreferencesWindow} window - Window for showing toast notifications
     * @param {string} monitorName - Name of the monitor (e.g., "Dell P2723D")
     */
    constructor(title, subtitle, settingsKey, displayController, window, monitorName) {
        this.title = title;
        this.subtitle = subtitle;
        this.settingsKey = settingsKey;
        this.displayController = displayController;
        this.window = window;
        this.monitorName = monitorName;

        // Preview state
        this.originalBrightness = null;
        this.brightnessQueryPromise = null; // Promise for the async brightness query
        this.isGrabbed = false;
        this.previewToast = null;

        // Track slider values to detect the pre-click original value.
        // GTK changes the slider value on click BEFORE the pressed gesture fires,
        // so we track previous/current values to recover the true original.
        this._prevNonPreviewValue = null;  // Value before the most recent non-preview change
        this._currNonPreviewValue = null;  // Value after the most recent non-preview change
        this._recentNonPreviewChange = false; // True if value-changed fired in current event cycle
        this._clearRecentChangeId = null;  // GLib idle source for clearing the flag

        // Throttling for preview updates (important for slow operations like ddcutil)
        this.lastPreviewUpdate = 0;
        this.previewThrottleMs = 200; // Minimum 200ms between updates
        this.pendingPreviewValue = null;
        this.previewTimeoutId = null;

        // Serialization for setBrightness calls (important for slow ddcutil)
        // Only one setBrightness runs at a time; new values are queued as "latest desired"
        this.brightnessInFlight = false;
        this.latestDesiredBrightness = null;
        this.lastPreviewPromise = null;

        // Create UI components
        this._createUI();
        this._setupPreview();
    }

    /**
     * Create the UI components (row, slider, adjustment).
     * @private
     */
    _createUI() {
        // Create the action row
        this.row = new Adw.ActionRow({
            title: this.title,
            subtitle: this.subtitle,
        });

        // Create the adjustment for the slider
        // If settingsKey is null, default to 50% (caller should set the actual value)
        const initialValue = this.settingsKey
            ? this.displayController.settings.get_int(this.settingsKey)
            : 50;

        this.adjustment = new Gtk.Adjustment({
            lower: 1,
            upper: 100,
            step_increment: 1,
            page_increment: 10,
            value: initialValue,
        });

        // Initialize pre-click value tracking
        this._prevNonPreviewValue = initialValue;
        this._currNonPreviewValue = initialValue;

        // Create the slider scale
        this.scale = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL,
            draw_value: true,
            value_pos: Gtk.PositionType.RIGHT,
            digits: 0,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            adjustment: this.adjustment,
        });

        // Wrap scale in a box to work around GTK4 GestureClick limitation
        // GtkScale doesn't properly emit gesture signals, so we need a parent container
        this.scaleBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            hexpand: true,
            valign: Gtk.Align.CENTER,
        });
        this.scaleBox.append(this.scale);

        // Add the box (containing the slider) to the row
        this.row.add_suffix(this.scaleBox);
    }

    /**
     * Set up the preview mechanism using GTK gestures.
     * This enables real-time brightness preview as the user drags the slider.
     * @private
     */
    _setupPreview() {
        // Create a click gesture controller to detect press and release
        // IMPORTANT: Attach to parent box, not scale directly (GTK4 limitation)
        // GtkScale doesn't properly propagate gesture events, so we use the parent container
        this.gesture = new Gtk.GestureClick();

        // Set propagation phase to CAPTURE so we catch events before the scale widget does
        this.gesture.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);

        // Attach to the parent box, not the scale itself
        this.scaleBox.add_controller(this.gesture);

        // When user presses down on the slider
        this.gesture.connect('pressed', () => {
            console.log(`[BrightnessSliderRow] Pressed signal received`);
            this._onPreviewStart();
        });

        // When gesture ends (includes button release)
        this.gesture.connect('end', () => {
            console.log(`[BrightnessSliderRow] End signal received`);
            this._onPreviewEnd();
        });

        // When slider value changes (during dragging)
        this.valueChangedSignal = this.adjustment.connect('value-changed', () => {
            this._onPreviewUpdate();
        });

        // Handle focus loss - ensure we clean up if user clicks away
        const focusController = new Gtk.EventControllerFocus();
        focusController.connect('leave', () => {
            if (this.isGrabbed) {
                console.log(`[BrightnessSliderRow] Focus lost while dragging - cleaning up`);
                this._onPreviewEnd();
            }
        });
        this.scale.add_controller(focusController);
    }

    /**
     * Called when user starts dragging the slider.
     * Saves the current brightness and shows preview toast with monitor name.
     * @private
     */
    _onPreviewStart() {
        console.log(`[BrightnessSliderRow] Preview started for ${this.title} on ${this.monitorName}`);

        // Don't start a new preview if one is already in progress
        if (this.isGrabbed) {
            console.log(`[BrightnessSliderRow] Preview already in progress, ignoring`);
            return;
        }

        this.isGrabbed = true;

        // Determine the reliable fallback value for the original brightness.
        // Two scenarios exist for how we arrived at this pressed event:
        //
        // A) Trough click: GTK changes value → value-changed → pressed
        //    _recentNonPreviewChange is true, and _prevNonPreviewValue has the PRE-CLICK value
        //
        // B) Thumb drag: pressed fires before any value-changed for this interaction
        //    _recentNonPreviewChange is false, and _currNonPreviewValue has the current value
        let fallbackValue;
        if (this._recentNonPreviewChange) {
            // Trough click: use the value from BEFORE the click-triggered change
            fallbackValue = this._prevNonPreviewValue;
            this._recentNonPreviewChange = false;
            console.log(`[BrightnessSliderRow] Trough click detected, pre-click value: ${fallbackValue}%`);
        } else {
            // Thumb drag: use the current tracked value
            fallbackValue = this._currNonPreviewValue;
            console.log(`[BrightnessSliderRow] Thumb drag detected, current value: ${fallbackValue}%`);
        }

        // Query the actual current SYSTEM brightness (not the slider's configured value).
        // _processNextBrightness gates on this promise so getBrightness ALWAYS completes
        // before our first setBrightness hits the hardware — no race on the i2c/VCP bus,
        // no risk of reading back our own preview write as the "original".
        console.log(`[BrightnessSliderRow] Querying current system brightness...`);
        this.brightnessQueryPromise = this.displayController.getBrightness().then(currentBrightness => {
            if (currentBrightness !== null) {
                this.originalBrightness = currentBrightness;
                console.log(`[BrightnessSliderRow] Saved original system brightness: ${this.originalBrightness}%`);
            } else {
                this.originalBrightness = fallbackValue;
                console.log(`[BrightnessSliderRow] getBrightness returned null, using tracked pre-interaction value: ${this.originalBrightness}%`);
            }
            return this.originalBrightness;
        }).catch(e => {
            console.error(`[BrightnessSliderRow] Failed to get current brightness: ${e}`);
            this.originalBrightness = fallbackValue;
            console.log(`[BrightnessSliderRow] Fallback to tracked value: ${this.originalBrightness}%`);
            return this.originalBrightness;
        });

        // Show a toast notification to indicate we're previewing on this specific monitor
        // Dismiss any existing preview toast first
        if (this.previewToast) {
            this.previewToast.dismiss();
        }

        this.previewToast = new Adw.Toast({
            title: `Previewing brightness on ${this.monitorName}`,
            timeout: 0,  // Don't auto-dismiss
        });
        this.window.add_toast(this.previewToast);
    }

    /**
     * Called when slider value changes during dragging.
     * Updates the actual screen brightness in real-time with throttling.
     * @private
     */
    _onPreviewUpdate() {
        if (!this.isGrabbed) {
            // Not in preview mode. Track the value BEFORE this change so we can
            // recover it if this value-changed was triggered by a trough click
            // (GTK changes the slider value BEFORE firing the pressed gesture).
            this._prevNonPreviewValue = this._currNonPreviewValue;
            this._currNonPreviewValue = Math.round(this.adjustment.get_value());
            this._recentNonPreviewChange = true;

            // Clear the flag after the current event cycle completes.
            // If pressed fires in the same cycle (trough click), the flag is still true.
            // If pressed fires later (thumb drag), the flag will have been cleared.
            if (this._clearRecentChangeId) {
                GLib.Source.remove(this._clearRecentChangeId);
            }
            this._clearRecentChangeId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._recentNonPreviewChange = false;
                this._clearRecentChangeId = null;
                return GLib.SOURCE_REMOVE;
            });
            return;
        }

        const value = Math.round(this.adjustment.get_value());
        const now = Date.now();
        const timeSinceLastUpdate = now - this.lastPreviewUpdate;

        // Store the pending value
        this.pendingPreviewValue = value;

        // If enough time has passed, update immediately
        if (timeSinceLastUpdate >= this.previewThrottleMs) {
            this._applyPreviewBrightness(value);
        } else {
            // Otherwise, schedule an update after the throttle period
            if (this.previewTimeoutId !== null) {
                // Clear any existing scheduled update
                GLib.Source.remove(this.previewTimeoutId);
            }

            const delay = this.previewThrottleMs - timeSinceLastUpdate;
            this.previewTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                // Check isGrabbed to prevent race condition if user releases just as timeout fires
                if (this.isGrabbed && this.pendingPreviewValue !== null) {
                    this._applyPreviewBrightness(this.pendingPreviewValue);
                    this.pendingPreviewValue = null;
                }
                this.previewTimeoutId = null;
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    /**
     * Apply brightness change to the display.
     * Uses "latest value wins" pattern - only one setBrightness runs at a time,
     * and intermediate values are skipped in favor of the most recent.
     * @param {number} value - Brightness value to apply
     * @private
     */
    _applyPreviewBrightness(value) {
        console.log(`[BrightnessSliderRow] Requesting preview brightness: ${value}% on ${this.monitorName}`);
        this.lastPreviewUpdate = Date.now();

        // Always store the latest desired value
        this.latestDesiredBrightness = value;

        // If a setBrightness is already in flight, just update latestDesiredBrightness
        // The in-flight operation will pick up the new value when it completes
        if (this.brightnessInFlight) {
            console.log(`[BrightnessSliderRow] setBrightness in flight, queued ${value}% as latest`);
            return;
        }

        // Start the brightness update loop
        this._processNextBrightness();
    }

    /**
     * Process the next brightness value in the queue.
     * Runs one setBrightness at a time, then checks for newer values.
     * @private
     */
    async _processNextBrightness() {
        // If no value to process or already processing, return
        if (this.latestDesiredBrightness === null || this.brightnessInFlight) {
            return;
        }

        // Check if still in preview mode
        if (!this.isGrabbed) {
            console.log(`[BrightnessSliderRow] Skipping preview apply - no longer grabbed`);
            this.latestDesiredBrightness = null;
            return;
        }

        // CRITICAL: wait for the original-brightness query to complete before issuing
        // the FIRST preview write. On controllers that share a single hardware channel
        // (ddcutil's i2c/VCP, brightnessctl's sysfs), running getBrightness and
        // setBrightness in parallel can race — getBrightness may read back our own
        // preview write as the "original", and the restore then sends the monitor to
        // the preview value instead of its true pre-drag brightness.
        //
        // After the first await, brightnessQueryPromise is null (cleared by
        // _restoreOriginalBrightness or by re-entry below), so subsequent ticks pay
        // no overhead.
        if (this.brightnessQueryPromise !== null) {
            try {
                await this.brightnessQueryPromise;
            } catch (e) {
                // The .then chain already converts failures into a fallback value, so
                // this catch is just defensive — nothing to do here.
            }
            // Re-check guards: user may have released during the await.
            if (!this.isGrabbed || this.latestDesiredBrightness === null) {
                return;
            }
        }

        // Take the current desired value and clear it
        const valueToApply = this.latestDesiredBrightness;
        this.latestDesiredBrightness = null;
        this.brightnessInFlight = true;

        console.log(`[BrightnessSliderRow] Applying preview brightness: ${valueToApply}% on ${this.monitorName}`);

        try {
            // Store promise so _restoreOriginalBrightness can wait for it
            this.lastPreviewPromise = this.displayController.setBrightness(valueToApply);
            await this.lastPreviewPromise;
        } catch (e) {
            console.error(`[BrightnessSliderRow] Preview setBrightness failed: ${e}`);
        }

        this.brightnessInFlight = false;

        // Check if a newer value came in while we were processing
        if (this.latestDesiredBrightness !== null && this.isGrabbed) {
            console.log(`[BrightnessSliderRow] Newer value ${this.latestDesiredBrightness}% queued, processing...`);
            this._processNextBrightness();
        }
    }

    /**
     * Called when user releases the slider.
     * Saves the final value and restores the original brightness.
     * @private
     */
    _onPreviewEnd() {
        console.log(`[BrightnessSliderRow] Preview ended for ${this.title} on ${this.monitorName}, isGrabbed=${this.isGrabbed}`);

        // If not grabbed, nothing to do
        if (!this.isGrabbed) {
            console.log(`[BrightnessSliderRow] Not in preview mode, ignoring end signal`);
            return;
        }

        // Cancel any pending preview updates
        if (this.previewTimeoutId !== null) {
            GLib.Source.remove(this.previewTimeoutId);
            this.previewTimeoutId = null;
        }

        this.isGrabbed = false;
        this.pendingPreviewValue = null;
        this._recentNonPreviewChange = false;
        if (this._clearRecentChangeId) {
            GLib.Source.remove(this._clearRecentChangeId);
            this._clearRecentChangeId = null;
        }

        // Save the final value to settings (only if settingsKey is provided)
        const finalValue = Math.round(this.adjustment.get_value());
        console.log(`[BrightnessSliderRow] Final value: ${finalValue}%`);
        if (this.settingsKey) {
            this.displayController.settings.set_int(this.settingsKey, finalValue);
        }
        // Note: If settingsKey is null, caller is responsible for saving via value-changed callback

        // Dismiss the preview toast immediately
        if (this.previewToast) {
            console.log(`[BrightnessSliderRow] Dismissing preview toast`);
            this.previewToast.dismiss();
            this.previewToast = null;
        }

        // Restore the original brightness
        // For slow controllers (like ddcutil), the brightness query may still be in progress
        // In that case, wait for it to complete before restoring
        this._restoreOriginalBrightness();
    }

    /**
     * Restore the original brightness, waiting for the query to complete if needed.
     * @private
     */
    async _restoreOriginalBrightness() {
        // Clear any pending brightness value - we're restoring, not previewing
        this.latestDesiredBrightness = null;

        // If the brightness query is still pending, wait for it
        if (this.originalBrightness === null && this.brightnessQueryPromise !== null) {
            console.log(`[BrightnessSliderRow] Waiting for brightness query to complete...`);
            try {
                await this.brightnessQueryPromise;
            } catch (e) {
                console.error(`[BrightnessSliderRow] Brightness query failed: ${e}`);
            }
        }

        // Clear the promise reference
        this.brightnessQueryPromise = null;

        // Wait for any in-flight preview setBrightness to complete before restoring
        // This is critical for slow controllers like ddcutil - if we don't wait,
        // the preview setBrightness might complete AFTER our restore setBrightness
        if (this.lastPreviewPromise !== null || this.brightnessInFlight) {
            console.log(`[BrightnessSliderRow] Waiting for in-flight preview setBrightness to complete...`);
            try {
                if (this.lastPreviewPromise) {
                    await this.lastPreviewPromise;
                }
            } catch (e) {
                console.error(`[BrightnessSliderRow] Preview setBrightness failed: ${e}`);
            }
            this.lastPreviewPromise = null;
            this.brightnessInFlight = false;
        }

        if (this.originalBrightness !== null) {
            console.log(`[BrightnessSliderRow] Restoring original brightness: ${this.originalBrightness}% on ${this.monitorName}`);

            // Store original brightness before clearing it
            const brightnessToRestore = this.originalBrightness;
            this.originalBrightness = null;

            // Restore brightness
            try {
                await this.displayController.setBrightness(brightnessToRestore);
                console.log(`[BrightnessSliderRow] Brightness restored successfully on ${this.monitorName}`);

                // Show a toast to confirm restoration with monitor name
                const restoredToast = new Adw.Toast({
                    title: `Brightness restored on ${this.monitorName}`,
                    timeout: 2,
                });
                this.window.add_toast(restoredToast);
            } catch (e) {
                console.error(`[BrightnessSliderRow] Failed to restore brightness: ${e}`);
                // Show error toast
                const errorToast = new Adw.Toast({
                    title: `Failed to restore brightness on ${this.monitorName}`,
                    timeout: 3,
                });
                this.window.add_toast(errorToast);
            }
        } else {
            console.log(`[BrightnessSliderRow] No original brightness to restore`);
        }
    }

    /**
     * Get the GTK widget for this component.
     * @returns {Adw.ActionRow} The action row widget
     */
    getWidget() {
        return this.row;
    }

    /**
     * Get the GTK adjustment for this slider.
     * Useful for binding to other UI elements.
     * @returns {Gtk.Adjustment} The adjustment object
     */
    getAdjustment() {
        return this.adjustment;
    }

    /**
     * Get the GTK scale (slider) widget.
     * @returns {Gtk.Scale} The scale widget
     */
    getScale() {
        return this.scale;
    }

    /**
     * Clean up resources and disconnect signals.
     * Call this when the component is no longer needed.
     */
    destroy() {
        // If currently previewing, restore brightness first
        if (this.isGrabbed && this.originalBrightness !== null) {
            // Restore synchronously before destroying
            this.displayController.setBrightness(this.originalBrightness);
            this.isGrabbed = false;
        }

        // Cancel any pending preview timeout
        if (this.previewTimeoutId !== null) {
            GLib.Source.remove(this.previewTimeoutId);
            this.previewTimeoutId = null;
        }

        // Cancel any pending idle callback for value change tracking
        if (this._clearRecentChangeId) {
            GLib.Source.remove(this._clearRecentChangeId);
            this._clearRecentChangeId = null;
        }

        // Dismiss any active toast
        if (this.previewToast) {
            this.previewToast.dismiss();
            this.previewToast = null;
        }

        // Disconnect signal handlers
        if (this.valueChangedSignal && this.adjustment) {
            this.adjustment.disconnect(this.valueChangedSignal);
            this.valueChangedSignal = null;
        }

        // Clear references
        this.gesture = null;
        this.row = null;
        this.adjustment = null;
        this.scale = null;
        this.scaleBox = null;
        this.displayController = null;
        this.window = null;
        this.originalBrightness = null;
        this.brightnessQueryPromise = null;
        this.lastPreviewPromise = null;
        this.brightnessInFlight = false;
        this.latestDesiredBrightness = null;
        this._prevNonPreviewValue = null;
        this._currNonPreviewValue = null;
        this._recentNonPreviewChange = false;
    }
}
