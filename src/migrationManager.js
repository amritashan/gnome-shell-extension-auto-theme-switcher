import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { BrightnessCtlDisplay } from './displayController.js';
import { debugLog, debugWarn } from './logger.js';

/**
 * Manages all data migrations between different extension versions.
 *
 * This class is autonomous - when instantiated and run(), it figures out
 * which migrations to execute based on the current data version.
 *
 * Version History:
 * - v0: Original published version with separate light-brightness/dark-brightness keys,
 *       API-based location detection and solar calculations (pre-v6)
 * - v1: Current version with unified monitors array (built-in + external monitors),
 *       local solar calculations, removed API dependencies (v6+)
 *
 * Usage:
 *   const manager = new MigrationManager(settings);
 *   await manager.run();
 */
export class MigrationManager {
    constructor(settings) {
        this.settings = settings;
        this.schemaPath = '/org/gnome/shell/extensions/auto-theme-switcher/';
    }

    /**
     * Run all necessary migrations based on current data version.
     * This is the main entry point - figures out what to run automatically.
     * @returns {Promise<void>}
     */
    async run() {
        try {
            const currentVersion = this.settings.get_int('data-version');
            debugLog(`MigrationManager: Current data version: ${currentVersion}`);

            // Run migrations in sequence based on version
            if (currentVersion < 1) {
                debugLog('MigrationManager: Running migration v0 → v1 (external monitors + local solar)');
                await this._migrateV0ToV1();
            }

            // Future migrations can be added here:
            // if (currentVersion < 2) {
            //     debugLog('MigrationManager: Running migration v1 → v2');
            //     await this._migrateV1ToV2();
            // }

            debugLog('MigrationManager: All migrations complete');
        } catch (e) {
            console.error(`MigrationManager: Migration system failed: ${e}`);
            debugWarn(`MigrationManager: Stack: ${e.stack}`);
            throw e; // Re-throw to let caller handle
        }
    }

    /**
     * Migrate from v0 (published version) to v1 (current version).
     *
     * This migration handles ALL changes from the old published version:
     * 1. Reads old light-brightness and dark-brightness from dconf (removed from schema)
     * 2. Creates builtin monitor entry with preserved values
     * 3. Falls back to current brightness for new users
     * 4. Cleans up old brightness keys
     * 5. Cleans up old API-related keys (auto-detect-location, api-cache, etc.)
     * 6. Initializes location-name if coordinates exist
     * 7. Updates data-version to 1
     *
     * Idempotency: Safe to run multiple times - checks for builtin monitor existence.
     * @private
     */
    async _migrateV0ToV1() {
        try {
            // IDEMPOTENCY CHECK: If builtin already exists, migration was already done
            const monitors = this._loadMonitors();
            const hasBuiltin = monitors.some(m => m.id === 'builtin');

            if (hasBuiltin) {
                debugLog('MigrationManager: Migration v0→v1 already complete (builtin exists)');
                // Ensure version is set correctly (in case it wasn't set before)
                this.settings.set_int('data-version', 1);
                return;
            }

            debugLog('MigrationManager: Starting migration v0 → v1');

            // Step 1: Try to read old brightness values from dconf directly
            // Old keys were removed from schema, so GSettings won't work
            const oldValues = await this._readOldBrightnessValues();

            // Step 2: Get other settings
            const defaultIncreaseDuration = this.settings.get_int('gradual-brightness-increase-duration');
            const defaultDecreaseDuration = this.settings.get_int('gradual-brightness-decrease-duration');
            const controlBrightness = this.settings.get_boolean('control-brightness');

            // Step 3: Determine brightness values to use
            let lightBrightness = oldValues.light;
            let darkBrightness = oldValues.dark;

            // If old values don't exist, read current brightness (new user)
            if (lightBrightness === null || darkBrightness === null) {
                debugLog('MigrationManager: Old brightness values not found, reading current brightness for new user');
                const currentBrightness = await this._readCurrentBrightness();

                // Use current for both to avoid jarring changes
                lightBrightness = lightBrightness ?? currentBrightness;
                darkBrightness = darkBrightness ?? currentBrightness;
            }

            // Step 4: Create builtin monitor entry
            const builtin = {
                id: 'builtin',
                name: 'Built-in Display',
                type: 'brightnessctl',
                enabled: controlBrightness,
                initialized: lightBrightness !== null && darkBrightness !== null,
                lightBrightness: lightBrightness,  // Preserved from old settings, or current for new users
                darkBrightness: darkBrightness,    // Preserved from old settings, or current for new users
                increaseDuration: defaultIncreaseDuration,
                decreaseDuration: defaultDecreaseDuration,
                lastSeen: Date.now()
            };

            // Step 5: Save builtin monitor
            monitors.unshift(builtin);
            this._saveMonitors(monitors);

            debugLog(`MigrationManager: Builtin monitor created - light=${lightBrightness ?? 'null'}%, dark=${darkBrightness ?? 'null'}%`);

            // Step 6: Clean up old brightness keys
            if (oldValues.light !== null || oldValues.dark !== null) {
                this._cleanupOldBrightnessKeys();
            }

            // Step 7: Clean up old API-related keys
            this._cleanupOldAPIKeys();

            // Step 8: Initialize location-name if coordinates exist but name doesn't
            this._initializeLocationName();

            // Step 9: Update data version (ONLY after successful migration)
            this.settings.set_int('data-version', 1);

            // Step 10: Set pending notification flag for ExtensionController to show
            this.settings.set_string('migration-notification-pending', 'v0-to-v1');
            debugLog('MigrationManager: Set migration notification pending');

            debugLog(`MigrationManager: Migration v0→v1 complete - ${monitors.length} total monitors`);

        } catch (e) {
            console.error(`MigrationManager: Migration v0→v1 failed: ${e}`);
            debugWarn(`MigrationManager: Stack: ${e.stack}`);
            // Don't update version if migration failed - will retry next time
            throw e;
        }
    }

    /**
     * Read old brightness values from dconf database.
     * Uses dconf read to bypass schema validation (keys were removed from schema).
     * @returns {Promise<{light: number|null, dark: number|null}>}
     * @private
     */
    async _readOldBrightnessValues() {
        let oldLightBrightness = null;
        let oldDarkBrightness = null;

        try {
            // Read old light-brightness from dconf database using async subprocess
            const procLight = Gio.Subprocess.new(
                ['dconf', 'read', `${this.schemaPath}light-brightness`],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );

            // Use callback pattern for GJS compatibility (prefs.js runs in different environment)
            const [stdoutLight] = await new Promise((resolve, reject) => {
                procLight.communicate_utf8_async(null, null, (proc, res) => {
                    try {
                        const [, stdout, stderr] = proc.communicate_utf8_finish(res);
                        resolve([stdout, stderr]);
                    } catch (e) {
                        reject(e);
                    }
                });
            });
            if (stdoutLight) {
                const lightValue = stdoutLight.trim();
                if (lightValue && lightValue !== '') {
                    oldLightBrightness = parseInt(lightValue);
                    debugLog(`MigrationManager: Found old light-brightness: ${oldLightBrightness}%`);
                }
            }

            // Read old dark-brightness from dconf database using async subprocess
            const procDark = Gio.Subprocess.new(
                ['dconf', 'read', `${this.schemaPath}dark-brightness`],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );

            // Use callback pattern for GJS compatibility
            const [stdoutDark] = await new Promise((resolve, reject) => {
                procDark.communicate_utf8_async(null, null, (proc, res) => {
                    try {
                        const [, stdout, stderr] = proc.communicate_utf8_finish(res);
                        resolve([stdout, stderr]);
                    } catch (e) {
                        reject(e);
                    }
                });
            });
            if (stdoutDark) {
                const darkValue = stdoutDark.trim();
                if (darkValue && darkValue !== '') {
                    oldDarkBrightness = parseInt(darkValue);
                    debugLog(`MigrationManager: Found old dark-brightness: ${oldDarkBrightness}%`);
                }
            }
        } catch (e) {
            debugWarn(`MigrationManager: Could not read old brightness values from dconf: ${e}`);
        }

        return {
            light: oldLightBrightness,
            dark: oldDarkBrightness
        };
    }

    /**
     * Read current brightness from the display (for new users).
     * @returns {Promise<number|null>}
     * @private
     */
    async _readCurrentBrightness() {
        try {
            const controller = new BrightnessCtlDisplay(this.settings);
            const isAvailable = await controller.isAvailable();

            if (isAvailable) {
                const currentBrightness = await controller.getBrightness();
                if (currentBrightness !== null) {
                    debugLog(`MigrationManager: Read current brightness: ${currentBrightness}%`);
                    return currentBrightness;
                }
            }
        } catch (e) {
            debugWarn(`MigrationManager: Could not read current brightness: ${e}`);
        }

        return null;
    }

    /**
     * Clean up old brightness keys after successful migration.
     * @private
     */
    _cleanupOldBrightnessKeys() {
        try {
            GLib.spawn_command_line_async(`dconf reset ${this.schemaPath}light-brightness`);
            GLib.spawn_command_line_async(`dconf reset ${this.schemaPath}dark-brightness`);
            debugLog('MigrationManager: Cleaned up old brightness keys');
        } catch (e) {
            debugWarn(`MigrationManager: Could not clean up old brightness keys: ${e}`);
        }
    }

    /**
     * Clean up old API-related keys that are no longer used.
     * These keys were removed when switching to local solar calculations.
     * @private
     */
    _cleanupOldAPIKeys() {
        const keysToRemove = [
            'auto-detect-location',
            'use-manual-coordinates',
            'api-cache',
            'last-api-error',
            'last-api-error-time',
        ];

        for (const key of keysToRemove) {
            try {
                GLib.spawn_command_line_async(`dconf reset ${this.schemaPath}${key}`);
                debugLog(`MigrationManager: Removed old API key: ${key}`);
            } catch (e) {
                // Key might not exist, which is fine
                debugLog(`MigrationManager: API key ${key} not found or already removed`);
            }
        }
    }

    /**
     * Initialize location-name if coordinates exist but name doesn't.
     * @private
     */
    _initializeLocationName() {
        try {
            const lat = this.settings.get_string('manual-latitude');
            const lng = this.settings.get_string('manual-longitude');
            const locationName = this.settings.get_string('location-name');

            if (lat && lng && !locationName) {
                // Coordinates exist but no name - set a placeholder
                this.settings.set_string('location-name', 'Custom Location');
                debugLog('MigrationManager: Set default location name for existing coordinates');
            }
        } catch (e) {
            debugWarn(`MigrationManager: Could not initialize location-name: ${e}`);
        }
    }

    /**
     * Load monitors from settings.
     * @returns {Array}
     * @private
     */
    _loadMonitors() {
        try {
            const json = this.settings.get_string('monitors');
            const monitors = JSON.parse(json);

            if (!Array.isArray(monitors)) {
                debugWarn('MigrationManager: Cached monitors is not an array');
                return [];
            }

            return monitors;
        } catch (e) {
            console.error(`MigrationManager: Failed to load monitors: ${e}`);
            return [];
        }
    }

    /**
     * Save monitors to settings.
     * @param {Array} monitors
     * @private
     */
    _saveMonitors(monitors) {
        try {
            // Add lastSeen timestamp to each monitor
            const monitorsWithTimestamp = monitors.map(m => ({
                ...m,
                lastSeen: Date.now()
            }));

            const json = JSON.stringify(monitorsWithTimestamp);
            this.settings.set_string('monitors', json);
            this.settings.set_int64('monitors-last-detection', Date.now());

            debugLog(`MigrationManager: Saved ${monitors.length} monitors to settings`);
        } catch (e) {
            console.error(`MigrationManager: Failed to save monitors: ${e}`);
            throw e;
        }
    }

    // ========================================================================
    // FUTURE MIGRATIONS
    // ========================================================================
    // Add new migration methods here as the extension evolves:
    //
    // async _migrateV1ToV2() {
    //     // Example future migration from v1 to v2
    // }
}
