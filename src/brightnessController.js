import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {
    BRIGHTNESS_UPDATE_INTERVAL_SECONDS,
    MS_PER_SECOND,
    MS_PER_DAY
} from './constants.js';

export class BrightnessController {
    constructor(settings) {
        this._settings = settings;
        this._brightnessTimeoutId = null;
        this._lastBrightnessUpdateTime = null;
        this._lightTime = null;
        this._darkTime = null;
    }

    setTimes(lightTime, darkTime) {
        this._lightTime = lightTime;
        this._darkTime = darkTime;
    }

    async checkBrightnessctlAvailable() {
        try {
            const proc = new Gio.Subprocess({
                argv: ['which', 'brightnessctl'],
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
            });
            proc.init(null);
            await proc.wait_check_async(null);
            return proc.get_successful();
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
            return;
        }

        // Check if brightnessctl is available
        const isBrightnessctlAvailable = await this.checkBrightnessctlAvailable();
        if (!isBrightnessctlAvailable) {
            return;
        }

        if (!this._lightTime || !this._darkTime) {
            return;
        }

        const now = new Date();
        const gradualDecreaseEnabled = this._settings.get_boolean('gradual-brightness-decrease-enabled');
        const gradualIncreaseEnabled = this._settings.get_boolean('gradual-brightness-increase-enabled');

        if (!gradualDecreaseEnabled && !gradualIncreaseEnabled) {
            return;
        }

        const decreaseDuration = this._settings.get_int('gradual-brightness-decrease-duration') * MS_PER_SECOND;
        const increaseDuration = this._settings.get_int('gradual-brightness-increase-duration') * MS_PER_SECOND;

        // Calculate when the next adjustment window starts
        const inDayPeriod = now >= this._lightTime && now < this._darkTime;
        let nextWindowStart;
        let nextWindowEnd;

        if (inDayPeriod) {
            if (gradualDecreaseEnabled) {
                const dimStartTime = new Date(this._darkTime.getTime() - decreaseDuration);
                if (now < dimStartTime) {
                    nextWindowStart = dimStartTime;
                    nextWindowEnd = this._darkTime;
                } else if (now < this._darkTime) {
                    nextWindowStart = now;
                    nextWindowEnd = this._darkTime;
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
                } else if (now < nextLightTime) {
                    nextWindowStart = now;
                    nextWindowEnd = nextLightTime;
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
            } else if (!inDayPeriod && gradualDecreaseEnabled) {
                const nextDarkTime = now >= this._darkTime ?
                    new Date(this._darkTime.getTime() + MS_PER_DAY) :
                    this._darkTime;
                nextWindowStart = new Date(nextDarkTime.getTime() - decreaseDuration);
                nextWindowEnd = nextDarkTime;
            } else {
                return;
            }
        }

        const secondsUntilWindowStart = Math.max(0, Math.round((nextWindowStart.getTime() - now.getTime()) / MS_PER_SECOND));

        if (secondsUntilWindowStart > 0) {
            this._brightnessTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, secondsUntilWindowStart, () => {
                this._startBrightnessUpdateLoop(nextWindowEnd);
                return GLib.SOURCE_REMOVE;
            });
        } else {
            this._startBrightnessUpdateLoop(nextWindowEnd);
        }
    }

    _startBrightnessUpdateLoop(windowEnd) {
        // Update immediately
        this.updateBrightness();

        // Clear any existing timer
        if (this._brightnessTimeoutId) {
            GLib.source_remove(this._brightnessTimeoutId);
            this._brightnessTimeoutId = null;
        }

        // Schedule updates every 10 minutes until window ends
        this._brightnessTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, BRIGHTNESS_UPDATE_INTERVAL_SECONDS, () => {
            const now = new Date();

            if (now >= windowEnd) {
                this.scheduleBrightnessUpdates();
                return GLib.SOURCE_REMOVE;
            }

            this.updateBrightness();
            return GLib.SOURCE_CONTINUE;
        });
    }

    updateBrightness(allowStaticBrightness = false) {
        const controlBrightness = this._settings.get_boolean('control-brightness');
        if (!controlBrightness || !this._lightTime || !this._darkTime) {
            return;
        }

        const now = new Date();
        const lightBrightness = this._settings.get_int('light-brightness');
        const darkBrightness = this._settings.get_int('dark-brightness');

        const transitionalBrightness = this.calculateBrightness(now, lightBrightness, darkBrightness);

        let targetBrightness;
        if (transitionalBrightness !== null) {
            targetBrightness = transitionalBrightness;
        } else if (allowStaticBrightness) {
            const inDayPeriod = now >= this._lightTime && now < this._darkTime;
            targetBrightness = inDayPeriod ? lightBrightness : darkBrightness;
        } else {
            return;
        }

        try {
            GLib.spawn_command_line_async(`brightnessctl set ${targetBrightness}%`);
            this._lastBrightnessUpdateTime = now.getTime();
            this._settings.set_string('last-brightness-update', this._lastBrightnessUpdateTime.toString());
        } catch (e) {
            console.error(`ThemeSwitcher: Failed to set brightness: ${e}`);
        }
    }

    calculateBrightness(now, lightBrightness, darkBrightness) {
        const lightTime = this._lightTime;
        const darkTime = this._darkTime;

        const gradualDecreaseEnabled = this._settings.get_boolean('gradual-brightness-decrease-enabled');
        const gradualIncreaseEnabled = this._settings.get_boolean('gradual-brightness-increase-enabled');
        const decreaseDuration = this._settings.get_int('gradual-brightness-decrease-duration') * MS_PER_SECOND;
        const increaseDuration = this._settings.get_int('gradual-brightness-increase-duration') * MS_PER_SECOND;

        let inDayPeriod = now >= lightTime && now < darkTime;

        if (now >= darkTime || now < lightTime) {
            inDayPeriod = false;
        }

        if (inDayPeriod) {
            if (gradualDecreaseEnabled) {
                const dimStartTime = new Date(darkTime.getTime() - decreaseDuration);

                if (now >= dimStartTime && now < darkTime) {
                    const elapsed = now.getTime() - dimStartTime.getTime();
                    const progress = elapsed / decreaseDuration;
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
                const brightenStartTime = new Date(nextLightTime.getTime() - increaseDuration);

                if (now >= brightenStartTime && now < nextLightTime) {
                    const elapsed = now.getTime() - brightenStartTime.getTime();
                    const progress = elapsed / increaseDuration;
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

    cleanup() {
        // Remove any active timers
        if (this._brightnessTimeoutId) {
            GLib.source_remove(this._brightnessTimeoutId);
            this._brightnessTimeoutId = null;
        }

        // Clear all state to prevent memory leaks
        this._settings = null;
        this._lastBrightnessUpdateTime = null;
        this._lightTime = null;
        this._darkTime = null;
    }
}
