import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

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
