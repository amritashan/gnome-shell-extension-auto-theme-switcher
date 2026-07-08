/**
 * TimeCalculator - Handles time parsing and trigger resolution
 *
 * Works with both local solar calculations (Date objects from suncalc)
 * and custom time strings (HH:MM format).
 */

/**
 * Seconds remaining until an absolute event timestamp, clamped to >= 0.
 *
 * The debug/status pipeline stores the ABSOLUTE next-event timestamp and
 * derives the countdown at read time with this helper. (A relative
 * seconds-to-event value computed at schedule time goes stale immediately —
 * the prefs Status tab used to re-anchor such a stale delta to a fresh "now",
 * freezing the countdown at whatever it was when the schedule was last built.)
 *
 * @param {number} eventTimestampMs - Event time as epoch milliseconds
 * @param {number} nowMs - Current time as epoch milliseconds
 * @returns {number} Whole seconds remaining, 0 if the event has passed or the
 *                   timestamp is missing/invalid
 */
export function secondsUntilEvent(eventTimestampMs, nowMs) {
    if (!eventTimestampMs || !Number.isFinite(eventTimestampMs)) {
        return 0;
    }
    return Math.max(0, Math.round((eventTimestampMs - nowMs) / 1000));
}

export class TimeCalculator {
    /**
     * Parse a trigger setting and return the corresponding time
     *
     * @param {string} trigger - The trigger type ('sunrise', 'sunset', 'custom', etc.)
     * @param {Object} solarTimes - Solar times from SolarCalculator (Date objects)
     * @param {Date} now - Current date/time
     * @param {string} mode - 'light' or 'dark'
     * @param {Object} settings - GSettings object
     * @returns {Date|null} The resolved time or null if invalid
     */
    parseTriggerTime(trigger, solarTimes, now, mode, settings) {
        if (trigger === 'custom') {
            const customTimeSetting = mode === 'light' ? 'custom-light-time' : 'custom-dark-time';
            const customTime = settings.get_string(customTimeSetting);
            return this.parseCustomTime(customTime, now);
        }

        // Map trigger names to solarTimes properties
        // solarTimes from SolarCalculator contains Date objects directly
        const triggerMap = {
            // Morning events (chronological order)
            'first-light': 'first_light',       // Astronomical dawn (-18°)
            'nautical-dawn': 'nautical_dawn',   // Nautical dawn (-12°)
            'dawn': 'dawn',                     // Civil dawn (-6°)
            'sunrise': 'sunrise',               // Sunrise (-0.833°)
            'sunrise-end': 'sunrise_end',       // Sun fully visible (-0.3°)
            'golden-hour-end': 'golden_hour_end', // Morning golden hour ends (6°)

            // Midday
            'solar-noon': 'solar_noon',

            // Evening events (chronological order)
            'golden-hour': 'golden_hour',       // Evening golden hour starts (6°)
            'sunset-start': 'sunset_start',     // Sun begins to set (-0.3°)
            'sunset': 'sunset',                 // Sunset (-0.833°)
            'dusk': 'dusk',                     // Civil dusk (-6°)
            'nautical-dusk': 'nautical_dusk',   // Nautical dusk (-12°)
            'last-light': 'last_light',         // Astronomical dusk (-18°)
        };

        const solarTimeKey = triggerMap[trigger];

        if (!solarTimeKey) {
            console.error(`TimeCalculator: Unknown trigger '${trigger}', using default`);
            const defaultKey = mode === 'light' ? 'sunrise' : 'sunset';
            return solarTimes[defaultKey] || null;
        }

        const time = solarTimes[solarTimeKey];

        if (!time || !(time instanceof Date) || isNaN(time.getTime())) {
            console.warn(`TimeCalculator: Invalid or missing time for trigger '${trigger}'`);
            return null;
        }

        return time;
    }

    /**
     * Parse a custom time string (HH:MM format) into a Date object for today
     *
     * @param {string} timeString - Time in HH:MM format (e.g., "07:00")
     * @param {Date} now - Current date/time (used to get today's date)
     * @returns {Date|null} Date object for today at the specified time, or null if invalid
     */
    parseCustomTime(timeString, now) {
        if (!timeString) {
            console.error('TimeCalculator: Empty time string provided');
            return null;
        }

        const timeParts = timeString.split(':');

        if (timeParts.length < 2) {
            console.error(`TimeCalculator: Invalid custom time format: ${timeString}`);
            return null;
        }

        const h = parseInt(timeParts[0], 10);
        const m = parseInt(timeParts[1], 10);

        if (isNaN(h) || isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) {
            console.error(`TimeCalculator: Invalid custom time values: ${timeString}`);
            return null;
        }

        return new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0);
    }
}
