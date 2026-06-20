import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const GSD_POWER_BUS = 'org.gnome.SettingsDaemon.Power';
const GSD_POWER_PATH = '/org/gnome/SettingsDaemon/Power';
const GSD_POWER_SCREEN_IFACE = 'org.gnome.SettingsDaemon.Power.Screen';

/**
 * Abstract base class for display brightness controllers.
 * Provides a unified interface for controlling brightness across different display types.
 */
export class DisplayController {
    /**
     * @param {Object} displayInfo - Display identification information
     * @param {string} displayInfo.id - Unique identifier for this display
     * @param {string} displayInfo.name - Human-readable name
     * @param {string} displayInfo.type - Display type (e.g., 'brightnessctl', 'ddcutil')
     * @param {Gio.Settings} settings - Extension settings object
     */
    constructor(displayInfo, settings) {
        this.displayInfo = displayInfo;
        this.settings = settings;
    }

    /**
     * Get current brightness value.
     * @returns {Promise<number|null>} Brightness value (0-100), or null if unavailable
     */
    async getBrightness() {
        throw new Error('getBrightness() must be implemented by subclass');
    }

    /**
     * Set brightness value.
     * @param {number} value - Brightness value (0-100)
     * @returns {Promise<boolean>} True if successful, false otherwise
     */
    async setBrightness(value) {
        throw new Error('setBrightness() must be implemented by subclass');
    }

    /**
     * Check if display is available and accessible.
     * @returns {Promise<boolean>} True if display can be controlled
     */
    async isAvailable() {
        throw new Error('isAvailable() must be implemented by subclass');
    }
}

/**
 * Display controller for laptop built-in displays using brightnessctl.
 */
export class BrightnessCtlDisplay extends DisplayController {
    constructor(settings) {
        super({
            id: 'builtin',
            name: 'Built-in Display',
            type: 'brightnessctl',
            identifier: null
        }, settings);
    }

    /**
     * Get current brightness as a percentage.
     * @returns {Promise<number|null>} Brightness percentage (1-100), or null if failed
     */
    async getBrightness() {
        try {
            // Get current brightness value
            const currentProc = new Gio.Subprocess({
                argv: ['brightnessctl', 'get'],
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
            });
            currentProc.init(null);

            const [currentStdout] = await new Promise((resolve, reject) => {
                currentProc.communicate_utf8_async(null, null, (proc, res) => {
                    try {
                        const [, stdout, stderr] = proc.communicate_utf8_finish(res);
                        resolve([stdout, stderr]);
                    } catch (e) {
                        reject(e);
                    }
                });
            });

            const current = parseInt(currentStdout.trim());

            // Get max brightness value
            const maxProc = new Gio.Subprocess({
                argv: ['brightnessctl', 'max'],
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
            });
            maxProc.init(null);

            const [maxStdout] = await new Promise((resolve, reject) => {
                maxProc.communicate_utf8_async(null, null, (proc, res) => {
                    try {
                        const [, stdout, stderr] = proc.communicate_utf8_finish(res);
                        resolve([stdout, stderr]);
                    } catch (e) {
                        reject(e);
                    }
                });
            });

            const max = parseInt(maxStdout.trim());

            if (isNaN(current) || isNaN(max) || max === 0) {
                console.error('Invalid brightness values:', { current, max });
                return null;
            }

            // Calculate percentage
            const percentage = Math.round((current / max) * 100);
            return Math.max(1, Math.min(100, percentage));
        } catch (e) {
            console.error(`BrightnessCtlDisplay: Failed to get brightness: ${e}`);
            return null;
        }
    }

    /**
     * Set brightness to a percentage value.
     * @param {number} value - Brightness percentage (1-100)
     * @returns {Promise<boolean>} True if successful
     */
    async setBrightness(value) {
        try {
            // Clamp value to valid range
            const clampedValue = Math.max(1, Math.min(100, Math.round(value)));

            // Use Gio.Subprocess to properly await command completion
            const proc = new Gio.Subprocess({
                argv: ['brightnessctl', 'set', `${clampedValue}%`],
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
            });
            proc.init(null);

            // Wait for the command to complete
            await new Promise((resolve, reject) => {
                proc.communicate_utf8_async(null, null, (proc, res) => {
                    try {
                        proc.communicate_utf8_finish(res);
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                });
            });

            return true;
        } catch (e) {
            console.error(`BrightnessCtlDisplay: Failed to set brightness: ${e}`);
            return false;
        }
    }

    /**
     * Check if brightnessctl is available on the system.
     * @returns {Promise<boolean>} True if brightnessctl is installed and accessible
     */
    async isAvailable() {
        try {
            const path = GLib.find_program_in_path('brightnessctl');
            return path !== null;
        } catch (e) {
            return false;
        }
    }
}

/**
 * Display controller for external monitors using ddcutil.
 * Uses DDC/CI protocol over I2C to control monitor settings.
 */
export class DdcutilDisplay extends DisplayController {
    /**
     * @param {Object} displayInfo - Display identification information
     * @param {string} displayInfo.id - Unique identifier (e.g., "DELL-P2723D-SN:ABC123")
     * @param {string} displayInfo.name - Human-readable name (e.g., "Dell P2723D")
     * @param {number} displayInfo.displayNumber - ddcutil display number (1-based)
     * @param {number} displayInfo.i2cBus - I2C bus number
     * @param {string} [displayInfo.manufacturer] - Manufacturer code
     * @param {string} [displayInfo.model] - Model name
     * @param {string} [displayInfo.serialNumber] - Serial number
     * @param {Gio.Settings} settings - Extension settings object
     */
    constructor(displayInfo, settings) {
        super({
            id: displayInfo.id,
            name: displayInfo.name,
            type: 'ddcutil',
            identifier: displayInfo.displayNumber
        }, settings);

        this.displayNumber = displayInfo.displayNumber;
        this.i2cBus = displayInfo.i2cBus;
        this.manufacturer = displayInfo.manufacturer || 'Unknown';
        this.model = displayInfo.model || 'Unknown';
        this.serialNumber = displayInfo.serialNumber || null;
    }

    /**
     * Get current brightness from the monitor via DDC/CI.
     * VCP Feature 0x10 = Brightness
     * @returns {Promise<number|null>} Brightness percentage (0-100), or null if failed
     */
    async getBrightness() {
        try {
            console.log(`[DdcutilDisplay] Reading brightness for ${this.displayInfo.name} (display ${this.displayNumber})...`);

            const proc = new Gio.Subprocess({
                argv: ['ddcutil', 'getvcp', '10', '--display', String(this.displayNumber), '--brief'],
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
            });
            console.log(`[DdcutilDisplay] Subprocess created, initializing...`);
            proc.init(null);

            console.log(`[DdcutilDisplay] Starting communicate_utf8_async...`);
            const [stdout, stderr] = await new Promise((resolve, reject) => {
                proc.communicate_utf8_async(null, null, (proc, res) => {
                    try {
                        const [, stdout, stderr] = proc.communicate_utf8_finish(res);
                        console.log(`[DdcutilDisplay] communicate_utf8_finish completed`);
                        resolve([stdout, stderr]);
                    } catch (e) {
                        console.error(`[DdcutilDisplay] communicate_utf8_finish error: ${e}`);
                        reject(e);
                    }
                });
            });

            console.log(`[DdcutilDisplay] Process completed`);

            // Check the actual exit status. ddcutil exits non-zero on permission
            // errors (user not in i2c group, missing udev rule), bus errors, or
            // when the monitor doesn't respond — without this check, callers would
            // misread the failure as a missing/unparseable response.
            if (!proc.get_successful()) {
                const status = proc.get_exit_status();
                const detail = stderr && stderr.trim() ? stderr.trim() : '(no stderr)';
                console.warn(`[DdcutilDisplay] ddcutil getvcp exited ${status} for ${this.displayInfo.name}: ${detail}`);
                return null;
            }

            const output = stdout.trim();
            console.log(`[DdcutilDisplay] stdout: "${output}"`);
            if (stderr && stderr.trim()) {
                console.log(`[DdcutilDisplay] stderr: "${stderr.trim()}"`);
            }

            // Parse output format: "VCP 10 C 50 100"
            // Where: VCP = prefix, 10 = feature code, C = continuous,
            //        50 = current value, 100 = maximum value
            const match = output.match(/VCP\s+10\s+C\s+(\d+)\s+(\d+)/);

            if (match) {
                const currentValue = parseInt(match[1]);
                const maxValue = parseInt(match[2]);

                if (isNaN(currentValue) || isNaN(maxValue) || maxValue === 0) {
                    console.error(`[DdcutilDisplay] Invalid brightness values for ${this.displayInfo.name}:`,
                                  { currentValue, maxValue });
                    return null;
                }

                // Calculate percentage
                const percentage = Math.round((currentValue / maxValue) * 100);
                console.log(`[DdcutilDisplay] Current brightness for ${this.displayInfo.name}: ${percentage}%`);
                return Math.max(0, Math.min(100, percentage));
            }

            console.error(`[DdcutilDisplay] Could not parse ddcutil output for ${this.displayInfo.name}: ${output}`);
            return null;
        } catch (e) {
            console.error(`[DdcutilDisplay] EXCEPTION in getBrightness for ${this.displayInfo.name}: ${e}`);
            console.error(`[DdcutilDisplay] Exception message: ${e.message}`);
            console.error(`[DdcutilDisplay] Exception stack: ${e.stack}`);
            return null;
        }
    }

    /**
     * Set brightness on the monitor via DDC/CI.
     * VCP Feature 0x10 = Brightness
     * @param {number} value - Brightness percentage (0-100)
     * @returns {Promise<boolean>} True if successful
     */
    async setBrightness(value) {
        try {
            // Clamp value to valid range
            const clampedValue = Math.max(0, Math.min(100, Math.round(value)));

            console.log(`[DdcutilDisplay] Setting brightness for ${this.displayInfo.name} to ${clampedValue}%`);

            // Use Gio.Subprocess to properly await command completion
            const proc = new Gio.Subprocess({
                argv: ['ddcutil', 'setvcp', '10', String(clampedValue), '--display', String(this.displayNumber)],
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
            });
            proc.init(null);

            // Wait for the command to complete
            const [, stderr] = await new Promise((resolve, reject) => {
                proc.communicate_utf8_async(null, null, (proc, res) => {
                    try {
                        const [, stdout, stderr] = proc.communicate_utf8_finish(res);
                        resolve([stdout, stderr]);
                    } catch (e) {
                        reject(e);
                    }
                });
            });

            // Check the actual exit status. Without this, a permission-denied
            // (e.g. user not in i2c group, missing udev rule) or any other
            // ddcutil failure was silently treated as success — and the cache
            // happily recorded the phantom write.
            if (!proc.get_successful()) {
                const status = proc.get_exit_status();
                const detail = stderr && stderr.trim() ? stderr.trim() : '(no stderr)';
                console.warn(`[DdcutilDisplay] ddcutil setvcp exited ${status} for ${this.displayInfo.name}: ${detail}`);
                return false;
            }

            if (stderr && stderr.trim()) {
                console.warn(`[DdcutilDisplay] stderr: ${stderr.trim()}`);
            }

            console.log(`[DdcutilDisplay] Brightness set to ${clampedValue}% for ${this.displayInfo.name}`);
            return true;
        } catch (e) {
            console.error(`DdcutilDisplay: Failed to set brightness for ${this.displayInfo.name}: ${e}`);
            return false;
        }
    }

    /**
     * Check if this specific display is available and responding.
     * @returns {Promise<boolean>} True if display can be communicated with
     */
    async isAvailable() {
        try {
            // Try to get brightness - if successful, display is available
            const brightness = await this.getBrightness();
            return brightness !== null;
        } catch (e) {
            console.error(`DdcutilDisplay: Failed to check availability for ${this.displayInfo.name}: ${e}`);
            return false;
        }
    }

    /**
     * Static method to check if ddcutil is installed on the system.
     * @returns {Promise<boolean>} True if ddcutil is installed
     */
    static async checkDdcutilInstalled() {
        try {
            const path = GLib.find_program_in_path('ddcutil');
            return path !== null;
        } catch (e) {
            return false;
        }
    }
}

/**
 * Display controller using GNOME's native Mutter backlight API.
 * Available in GNOME 49+ for both built-in and external monitors.
 * Uses monitor.get_backlight() for DDC/CI and backlight control.
 */
export class MutterBacklightDisplay extends DisplayController {
    /**
     * @param {Object} displayInfo - Display identification information
     * @param {string} displayInfo.id - Unique identifier for this display
     * @param {string} displayInfo.name - Human-readable name
     * @param {string} displayInfo.displayName - The display name from Mutter (used to find the monitor)
     * @param {Gio.Settings} settings - Extension settings object
     */
    constructor(displayInfo, settings) {
        super({
            id: displayInfo.id,
            name: displayInfo.name,
            type: 'mutter-backlight',
            identifier: displayInfo.displayName
        }, settings);

        this.displayName = displayInfo.displayName;
    }

    /**
     * Find the monitor and its backlight by display name.
     * @returns {Object|null} Object with {monitor, backlight} or null if not found
     * @private
     */
    _findMonitorBacklight() {
        // The Mutter API is only reachable in the shell context. The prefs context
        // also probes display backends (for slider previews) but `global` is
        // undefined there — guard up front to avoid noisy ReferenceError logs from
        // the catch below.
        if (typeof global === 'undefined' || !global.backend) {
            return null;
        }
        try {
            const monitorManager = global.backend.get_monitor_manager();
            // Mutter's logical monitor enumeration only exists on GNOME 49+ — on
            // older releases this method is missing and probeDisplayController
            // correctly falls through to the legacy backends.
            if (typeof monitorManager?.get_logical_monitors !== 'function') {
                return null;
            }
            const logicalMonitors = monitorManager.get_logical_monitors();

            for (const lm of logicalMonitors) {
                for (const monitor of lm.get_monitors()) {
                    if (!monitor.is_active()) continue;

                    const backlight = monitor.get_backlight();
                    if (!backlight) continue;

                    // Match by display name
                    const name = monitor.get_display_name();
                    if (name === this.displayName) {
                        return { monitor, backlight };
                    }
                }
            }
            return null;
        } catch (e) {
            console.error(`MutterBacklightDisplay: Error finding monitor: ${e}`);
            return null;
        }
    }

    /**
     * Get current brightness as a percentage.
     * @returns {Promise<number|null>} Brightness percentage (0-100), or null if failed
     */
    async getBrightness() {
        try {
            const result = this._findMonitorBacklight();
            if (!result) {
                console.warn(`MutterBacklightDisplay: Monitor "${this.displayName}" not found or has no backlight`);
                return null;
            }

            const { backlight } = result;
            const { brightness, brightnessMin: min, brightnessMax: max } = backlight;

            if (max === min) {
                console.warn(`MutterBacklightDisplay: Invalid brightness range for ${this.displayName}`);
                return null;
            }

            // Calculate percentage (0-100)
            const percentage = Math.round(((brightness - min) / (max - min)) * 100);
            return Math.max(0, Math.min(100, percentage));
        } catch (e) {
            console.error(`MutterBacklightDisplay: Failed to get brightness for ${this.displayName}: ${e}`);
            return null;
        }
    }

    /**
     * Set brightness to a percentage value.
     * @param {number} value - Brightness percentage (0-100)
     * @returns {Promise<boolean>} True if successful
     */
    async setBrightness(value) {
        try {
            const result = this._findMonitorBacklight();
            if (!result) {
                console.warn(`MutterBacklightDisplay: Monitor "${this.displayName}" not found or has no backlight`);
                return false;
            }

            const { backlight } = result;
            const { brightnessMin: min, brightnessMax: max } = backlight;

            // Convert percentage (0-100) to backlight range
            const clampedValue = Math.max(0, Math.min(100, Math.round(value)));
            const brightnessValue = min + ((max - min) * clampedValue / 100);

            backlight.brightness = Math.round(brightnessValue);

            console.log(`MutterBacklightDisplay: Set ${this.displayName} brightness to ${clampedValue}%`);
            return true;
        } catch (e) {
            console.error(`MutterBacklightDisplay: Failed to set brightness for ${this.displayName}: ${e}`);
            return false;
        }
    }

    /**
     * Check if this display is available and has backlight control.
     * @returns {Promise<boolean>} True if display can be controlled
     */
    async isAvailable() {
        const result = this._findMonitorBacklight();
        return result !== null;
    }

    /**
     * Get all monitors with backlight support.
     * Static method for discovery.
     * @returns {Array} Array of monitor info objects
     */
    static getAvailableMonitors() {
        const monitors = [];

        try {
            const monitorManager = global.backend.get_monitor_manager();
            const logicalMonitors = monitorManager.get_logical_monitors();

            for (const lm of logicalMonitors) {
                for (const monitor of lm.get_monitors()) {
                    if (!monitor.is_active()) continue;

                    const backlight = monitor.get_backlight();
                    if (!backlight) continue;

                    const displayName = monitor.get_display_name();
                    const connector = monitor.get_connector();

                    monitors.push({
                        id: `mutter-${connector || displayName}`,
                        name: displayName,
                        displayName: displayName,
                        connector: connector,
                        type: 'mutter-backlight',
                        // Include current brightness info
                        brightnessMin: backlight.brightnessMin,
                        brightnessMax: backlight.brightnessMax,
                        currentBrightness: backlight.brightness
                    });
                }
            }
        } catch (e) {
            console.error(`MutterBacklightDisplay: Error getting available monitors: ${e}`);
        }

        return monitors;
    }
}

/**
 * Display controller for the built-in laptop display via gnome-settings-daemon's
 * Power d-bus service. Avoids spawning brightnessctl on GNOME versions where
 * the native Mutter backlight API isn't available (pre-49).
 *
 * D-Bus interface: org.gnome.SettingsDaemon.Power.Screen
 *   Property "Brightness" (int32, 0-100, or -1 if no backlight)
 */
export class SettingsDaemonPowerDisplay extends DisplayController {
    constructor(settings) {
        super({
            id: 'builtin',
            name: 'Built-in Display',
            type: 'gsd-power',
            identifier: null
        }, settings);
        this._proxy = null;
    }

    async _getProxy() {
        if (!this._proxy) {
            this._proxy = await Gio.DBusProxy.new(
                Gio.DBus.session,
                Gio.DBusProxyFlags.DO_NOT_AUTO_START,
                null,
                GSD_POWER_BUS,
                GSD_POWER_PATH,
                GSD_POWER_SCREEN_IFACE,
                null
            );
        }
        return this._proxy;
    }

    async getBrightness() {
        const proxy = await this._getProxy();
        const variant = proxy.get_cached_property('Brightness');
        if (variant === null) return null;
        const value = variant.get_int32();
        if (value < 0) return null;
        return Math.max(0, Math.min(100, value));
    }

    async setBrightness(value) {
        try {
            const proxy = await this._getProxy();
            const clamped = Math.max(0, Math.min(100, Math.round(value)));
            // Use the explicit-callback form rather than relying on GJS's
            // promise auto-conversion. The latter requires a specific GJS
            // version; on older GJS, calling without a callback throws
            // "method Gio.DBusProxy.call: At least 6 arguments required".
            await new Promise((resolve, reject) => {
                proxy.call(
                    'org.freedesktop.DBus.Properties.Set',
                    new GLib.Variant('(ssv)', [
                        GSD_POWER_SCREEN_IFACE,
                        'Brightness',
                        new GLib.Variant('i', clamped),
                    ]),
                    Gio.DBusCallFlags.NONE,
                    -1,
                    null,
                    (proxyArg, res) => {
                        try {
                            proxyArg.call_finish(res);
                            resolve();
                        } catch (err) {
                            reject(err);
                        }
                    }
                );
            });
            return true;
        } catch (e) {
            console.error(`SettingsDaemonPowerDisplay: Failed to set brightness: ${e}`);
            return false;
        }
    }

    async isAvailable() {
        try {
            const brightness = await this.getBrightness();
            return brightness !== null;
        } catch (e) {
            return false;
        }
    }
}

/**
 * Pick the best available DisplayController for a monitor by probing backends
 * in priority order:
 *
 *   1. MutterBacklight     — native Mutter API, GNOME 49+, all monitor kinds
 *   2. SettingsDaemonPower — gnome-settings-daemon Power d-bus, built-in only
 *   3. BrightnessCtl       — brightnessctl spawn fallback, built-in last resort
 *   4. Ddcutil             — ddcutil spawn, external monitors on pre-49
 *
 * Always resolves — the last-resort spawn backends are returned without
 * probing if nothing better matches, so callers don't need rejection handling.
 *
 * Used by both the shell-side BrightnessController and the prefs-side
 * MonitorConfigDialog so the d-bus path is taken consistently in both places.
 *
 * @param {Object} monitor - Monitor object from settings (must have id, name; type optional)
 * @param {Gio.Settings} settings - Extension settings
 * @returns {Promise<DisplayController>}
 */
export async function probeDisplayController(monitor, settings) {
    const mutter = new MutterBacklightDisplay({
        id: monitor.id,
        name: monitor.name,
        displayName: monitor.name,
    }, settings);
    if (await mutter.isAvailable()) {
        console.log(`probeDisplayController: ${monitor.name} → Mutter backlight API`);
        return mutter;
    }

    const isBuiltin = monitor.id === 'builtin' || monitor.type === 'brightnessctl';

    if (isBuiltin) {
        const dbus = new SettingsDaemonPowerDisplay(settings);
        if (await dbus.isAvailable()) {
            console.log(`probeDisplayController: ${monitor.name} → SettingsDaemon.Power d-bus`);
            return dbus;
        }
        console.log(`probeDisplayController: ${monitor.name} → brightnessctl (last resort)`);
        return new BrightnessCtlDisplay(settings);
    }

    console.log(`probeDisplayController: ${monitor.name} → ddcutil`);
    return new DdcutilDisplay(monitor, settings);
}
