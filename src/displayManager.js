import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { DdcutilDisplay, BrightnessCtlDisplay } from './displayController.js';
import { MigrationManager } from './migrationManager.js';

/**
 * Manages detection and tracking of all monitors (built-in and external).
 * Handles:
 * - Built-in display via brightnessctl
 * - External monitors via ddcutil
 * - Unified monitor list management
 */
export class DisplayManager {
    constructor(settings) {
        this.settings = settings;

        // Track migration promise
        this._migrationPromise = null;
    }

    /**
     * Ensure all data migrations have completed before using the DisplayManager.
     * Delegates to MigrationManager for all migration logic.
     * Call this before any operations that need the monitors list.
     * @returns {Promise<void>}
     */
    async ensureMigrated() {
        if (!this._migrationPromise) {
            const migrationManager = new MigrationManager(this.settings);
            this._migrationPromise = migrationManager.run();
        }
        await this._migrationPromise;
    }

    /**
     * Detect all external monitors using ddcutil.
     * This can take 5-30 seconds depending on the number of monitors.
     * @returns {Promise<Array>} Array of monitor objects with parsed information
     */
    async detectExternalMonitors() {
        try {
            // Check if ddcutil is installed first
            const isDdcutilInstalled = await DdcutilDisplay.checkDdcutilInstalled();
            if (!isDdcutilInstalled) {
                console.log('DisplayManager: ddcutil is not installed');
                return [];
            }

            console.log('DisplayManager: Starting monitor detection...');
            const startTime = Date.now();

            // Use async subprocess to avoid freezing the shell (can take 5-30 seconds)
            const proc = Gio.Subprocess.new(
                ['ddcutil', 'detect'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );

            // Use callback pattern for GJS compatibility (prefs.js runs in different environment)
            const [stdout, stderr] = await new Promise((resolve, reject) => {
                proc.communicate_utf8_async(null, null, (proc, res) => {
                    try {
                        const [, stdout, stderr] = proc.communicate_utf8_finish(res);
                        resolve([stdout, stderr]);
                    } catch (e) {
                        reject(e);
                    }
                });
            });
            const output = stdout || '';
            const errorOutput = stderr || '';

            // Parse monitors first
            const monitors = this._parseDetectOutput(output);

            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            console.log(`DisplayManager: Detected ${monitors.length} monitors in ${elapsed}s`);

            // Log any warnings/errors from stderr
            if (errorOutput && errorOutput.trim() !== '') {
                // Only treat as fatal error if no monitors detected AND there's a permission error
                if (monitors.length === 0 && (errorOutput.includes('Permission denied') || errorOutput.includes('EACCES'))) {
                    console.error('DisplayManager: Permission denied and no monitors detected');
                    console.error('DisplayManager: Run: sudo usermod -a -G i2c $USER');
                    console.error('DisplayManager: Then log out and log back in');
                    throw new Error('Permission denied: You need to be in the i2c group. See installation instructions.');
                }

                // Otherwise just log warnings (permission errors on unused I2C devices are common)
                console.warn(`DisplayManager: ddcutil stderr output: ${errorOutput}`);
            }

            return monitors;
        } catch (e) {
            console.error(`DisplayManager: Error detecting monitors: ${e}`);
            throw e; // Re-throw to let the dialog show the error
        }
    }

    /**
     * Parse ddcutil detect output into structured monitor objects.
     * @param {string} output - Raw output from 'ddcutil detect --brief'
     * @returns {Array} Array of monitor objects
     * @private
     */
    _parseDetectOutput(output) {
        const monitors = [];

        // Split output by "Display" entries
        const displayBlocks = output.split(/Display\s+\d+/).slice(1);

        let displayNumber = 1;
        for (const block of displayBlocks) {
            try {
                const monitor = this._parseDisplayBlock(block, displayNumber);
                if (monitor) {
                    monitors.push(monitor);
                    displayNumber++;
                }
            } catch (e) {
                console.error(`DisplayManager: Error parsing display block: ${e}`);
                console.error(`Block content: ${block}`);
            }
        }

        return monitors;
    }

    /**
     * Parse a single display block from ddcutil output.
     * @param {string} block - Text block for one display
     * @param {number} displayNumber - Display number (1-based)
     * @returns {Object|null} Monitor object or null if parsing fails
     * @private
     */
    _parseDisplayBlock(block, displayNumber) {
        const monitor = {
            displayNumber: displayNumber,
            i2cBus: null,
            drmConnector: null,
            manufacturer: null,
            model: null,
            productCode: null,
            serialNumber: null,
            binarySerial: null,
            manufactureYear: null,
            manufactureWeek: null
        };

        // Parse I2C bus: "/dev/i2c-1"
        const i2cMatch = block.match(/I2C bus:\s+\/dev\/i2c-(\d+)/);
        if (i2cMatch) {
            monitor.i2cBus = parseInt(i2cMatch[1]);
        }

        // Parse DRM connector: "card0-HDMI-A-1"
        const drmMatch = block.match(/DRM connector:\s+(.+)/);
        if (drmMatch) {
            monitor.drmConnector = drmMatch[1].trim();
        }

        // Parse manufacturer ID: "DEL", "SAM", "GSM", etc.
        const mfgMatch = block.match(/Mfg id:\s+([A-Z]{3})/);
        if (mfgMatch) {
            monitor.manufacturer = mfgMatch[1];
        }

        // Parse model name: "DELL P2723D", "U32H75x", etc.
        const modelMatch = block.match(/Model:\s+(.+)/);
        if (modelMatch) {
            monitor.model = modelMatch[1].trim();
        }

        // Parse product code: "3586 (0x0e02)"
        const productMatch = block.match(/Product code:\s+(\d+)/);
        if (productMatch) {
            monitor.productCode = parseInt(productMatch[1]);
        }

        // Parse serial number (text): "HTOJ900304"
        const serialMatch = block.match(/Serial number:\s+(.+)/);
        if (serialMatch) {
            const serial = serialMatch[1].trim();
            // Ignore placeholder values
            monitor.serialNumber = (serial === "Unspecified" || serial === "0") ? null : serial;
        }

        // Parse binary serial number: "808465444 (0x30514d44)"
        const binaryMatch = block.match(/Binary serial number:\s+\d+\s+\((.+)\)/);
        if (binaryMatch) {
            const binarySerial = binaryMatch[1].trim();
            // Ignore placeholder values
            monitor.binarySerial = (binarySerial === "0x0" || binarySerial === "0x00000000") ? null : binarySerial;
        }

        // Parse manufacture date: "Manufacture year: 2022,  Week: 39"
        const dateMatch = block.match(/Manufacture year:\s+(\d+),\s+Week:\s+(\d+)/);
        if (dateMatch) {
            monitor.manufactureYear = parseInt(dateMatch[1]);
            monitor.manufactureWeek = parseInt(dateMatch[2]);
        }

        // Generate unique ID and human-readable name
        monitor.id = this._generateMonitorId(monitor);
        monitor.name = this._generateMonitorName(monitor);

        // Validate we have minimum required information
        if (!monitor.i2cBus || !monitor.manufacturer || !monitor.model) {
            console.warn('DisplayManager: Incomplete monitor information, skipping:', monitor);
            return null;
        }

        return monitor;
    }

    /**
     * Generate a unique ID for a monitor.
     * Priority: Serial Number > Binary Serial > I2C Bus
     * @param {Object} monitor - Monitor object
     * @returns {string} Unique identifier
     * @private
     */
    _generateMonitorId(monitor) {
        const { manufacturer, model, serialNumber, binarySerial, i2cBus } = monitor;

        // Priority 1: Text serial number (best for multiple identical monitors)
        if (serialNumber) {
            return `${manufacturer}-${model}-SN:${serialNumber}`;
        }

        // Priority 2: Binary serial number
        if (binarySerial) {
            return `${manufacturer}-${model}-BSN:${binarySerial}`;
        }

        // Priority 3: I2C bus number (warning: can change if ports change)
        console.warn(
            `DisplayManager: Monitor ${manufacturer} ${model} has no serial number. ` +
            `Using I2C bus for identification. Settings may not persist if monitor is ` +
            `plugged into a different port.`
        );
        return `${manufacturer}-${model}-BUS:${i2cBus}`;
    }

    /**
     * Generate a human-readable name for a monitor.
     * @param {Object} monitor - Monitor object
     * @returns {string} Display name
     * @private
     */
    _generateMonitorName(monitor) {
        const { manufacturer, model } = monitor;

        // Expand common manufacturer codes
        const mfgNames = {
            'DEL': 'Dell',
            'SAM': 'Samsung',
            'GSM': 'LG',
            'HWP': 'HP',
            'ACI': 'ASUS',
            'ACR': 'Acer',
            'BNQ': 'BenQ',
            'AOC': 'AOC',
            'LEN': 'Lenovo',
            'NEC': 'NEC',
            'VSC': 'ViewSonic',
            'IVM': 'Iiyama',
            'ENC': 'Eizo'
        };

        const mfgName = mfgNames[manufacturer] || manufacturer;
        return `${mfgName} ${model}`;
    }

    /**
     * Load cached monitor list from settings.
     * @returns {Array} Array of monitor objects from settings
     */
    loadCachedMonitors() {
        try {
            const json = this.settings.get_string('monitors');
            const monitors = JSON.parse(json);

            if (!Array.isArray(monitors)) {
                console.warn('DisplayManager: Cached monitors is not an array');
                return [];
            }

            monitors.forEach(m => {
                console.log(`DisplayManager: Loaded monitor: id=${m.id}, name=${m.name}, enabled=${m.enabled}, initialized=${m.initialized}, lightBrightness=${m.lightBrightness}, darkBrightness=${m.darkBrightness}`);
            });
            return monitors;
        } catch (e) {
            console.error(`DisplayManager: Failed to load cached monitors: ${e}`);
            return [];
        }
    }

    /**
     * Save monitor list to settings.
     * @param {Array} monitors - Array of monitor objects to save
     */
    saveMonitors(monitors) {
        try {
            // Add lastSeen timestamp to each monitor
            const monitorsWithTimestamp = monitors.map(m => ({
                ...m,
                lastSeen: Date.now()
            }));

            const json = JSON.stringify(monitorsWithTimestamp);
            this.settings.set_string('monitors', json);
            this.settings.set_int64('monitors-last-detection', Date.now());

            console.log(`DisplayManager: Saved ${monitors.length} monitors to settings`);
        } catch (e) {
            console.error(`DisplayManager: Failed to save monitors: ${e}`);
        }
    }

    /**
     * Merge newly detected monitors with cached monitors.
     * Preserves user settings (enabled, brightness values) for known monitors.
     * @param {Array} detectedMonitors - Newly detected monitors
     * @param {Array} cachedMonitors - Previously saved monitors
     * @returns {Array} Merged monitor list
     */
    mergeMonitors(detectedMonitors, cachedMonitors) {
        const merged = [];
        const cachedById = new Map(cachedMonitors.map(m => [m.id, m]));

        // Get default duration values from settings
        const defaultIncreaseDuration = this.settings.get_int('gradual-brightness-increase-duration');
        const defaultDecreaseDuration = this.settings.get_int('gradual-brightness-decrease-duration');

        for (const detected of detectedMonitors) {
            const cached = cachedById.get(detected.id);

            if (cached) {
                // Known monitor - preserve user settings
                console.log(`DisplayManager: Merging detected monitor ${detected.id} with cached: enabled=${cached.enabled}, initialized=${cached.initialized}, lightBrightness=${cached.lightBrightness}, darkBrightness=${cached.darkBrightness}`);
                merged.push({
                    ...detected,
                    enabled: cached.enabled,
                    lightBrightness: cached.lightBrightness,
                    darkBrightness: cached.darkBrightness,
                    increaseDuration: cached.increaseDuration || defaultIncreaseDuration,
                    decreaseDuration: cached.decreaseDuration || defaultDecreaseDuration,
                    initialized: cached.initialized
                });
            } else {
                // New monitor - add with defaults
                console.log(`DisplayManager: New monitor detected ${detected.id}, using defaults`);
                merged.push({
                    ...detected,
                    enabled: false,  // User must explicitly enable
                    lightBrightness: null,
                    darkBrightness: null,
                    increaseDuration: defaultIncreaseDuration,
                    decreaseDuration: defaultDecreaseDuration,
                    initialized: false
                });
            }
        }

        console.log(`DisplayManager: Merged ${merged.length} monitors (${detectedMonitors.length} detected, ${cachedMonitors.length} cached)`);
        return merged;
    }

    /**
     * Find monitors that were in cache but not detected (possibly unplugged).
     * @param {Array} detectedMonitors - Newly detected monitors
     * @param {Array} cachedMonitors - Previously saved monitors
     * @returns {Array} Monitors that were cached but not detected
     */
    findMissingMonitors(detectedMonitors, cachedMonitors) {
        const detectedIds = new Set(detectedMonitors.map(m => m.id));
        const missing = cachedMonitors.filter(m => !detectedIds.has(m.id));

        if (missing.length > 0) {
            console.log(`DisplayManager: ${missing.length} cached monitors not detected (possibly unplugged):`,
                       missing.map(m => m.name));
        }

        return missing;
    }
}
