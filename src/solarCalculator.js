/**
 * SolarCalculator - Local solar event calculations using suncalc library
 *
 * This module provides sunrise, sunset, and other solar event times calculated
 * locally without requiring external API calls. It uses the suncalc library
 * which implements the NOAA Solar Calculator algorithms.
 *
 * Accuracy: Within 1-2 minutes for locations between +/- 72 degrees latitude.
 */

import * as SunCalc from './lib/suncalc.js';

export class SolarCalculator {
    constructor() {
        // suncalc provides these events by default:
        // - sunrise, sunset (sun at -0.833 degrees - accounts for refraction)
        // - sunriseEnd, sunsetStart (sun at -0.3 degrees)
        // - dawn, dusk (civil twilight, sun at -6 degrees)
        // - nauticalDawn, nauticalDusk (sun at -12 degrees)
        // - nightEnd, night (astronomical twilight, sun at -18 degrees)
        // - goldenHourEnd, goldenHour (sun at 6 degrees)
        // - solarNoon, nadir
    }

    /**
     * Calculate all solar events for a given date and location
     * @param {Date} date - The date to calculate for
     * @param {number} latitude - Latitude in decimal degrees
     * @param {number} longitude - Longitude in decimal degrees
     * @returns {Object} Solar event times matching the format expected by the extension
     */
    getSolarTimes(date, latitude, longitude) {
        const lat = parseFloat(latitude);
        const lng = parseFloat(longitude);

        if (isNaN(lat) || isNaN(lng)) {
            console.error('SolarCalculator: Invalid coordinates provided');
            return null;
        }

        // Get times from suncalc
        const times = SunCalc.getTimes(date, lat, lng);

        // Map suncalc output to our extension's expected format
        // Our extension uses these triggers:
        // - first-light (astronomical dawn) -> nightEnd
        // - dawn (civil dawn) -> dawn
        // - sunrise -> sunrise
        // - solar-noon -> solarNoon
        // - golden-hour -> goldenHour
        // - sunset -> sunset
        // - dusk (civil dusk) -> dusk
        // - last-light (astronomical dusk) -> night

        return {
            // Morning events (in chronological order)
            first_light: times.nightEnd,       // Astronomical dawn (-18°)
            nautical_dawn: times.nauticalDawn, // Nautical dawn (-12°)
            dawn: times.dawn,                  // Civil dawn (-6°)
            sunrise: times.sunrise,            // Sunrise (-0.833°)
            sunrise_end: times.sunriseEnd,     // Sun fully visible (-0.3°)
            golden_hour_end: times.goldenHourEnd, // Morning golden hour ends (6°)

            // Midday
            solar_noon: times.solarNoon,

            // Evening events (in chronological order)
            golden_hour: times.goldenHour,     // Evening golden hour starts (6°)
            sunset_start: times.sunsetStart,   // Sun begins to set (-0.3°)
            sunset: times.sunset,              // Sunset (-0.833°)
            dusk: times.dusk,                  // Civil dusk (-6°)
            nautical_dusk: times.nauticalDusk, // Nautical dusk (-12°)
            last_light: times.night,           // Astronomical dusk (-18°)

            // Additional reference times
            nadir: times.nadir,                // Solar midnight (opposite of solar noon)
        };
    }

    /**
     * Get a human-readable timezone string
     * @returns {string} Timezone string (e.g., "America/Los_Angeles")
     */
    getTimezone() {
        try {
            return Intl.DateTimeFormat().resolvedOptions().timeZone;
        } catch (e) {
            return 'Unknown';
        }
    }

    /**
     * Validate that coordinates are within acceptable ranges
     * @param {string|number} latitude
     * @param {string|number} longitude
     * @returns {boolean}
     */
    validateCoordinates(latitude, longitude) {
        const lat = parseFloat(latitude);
        const lng = parseFloat(longitude);

        if (isNaN(lat) || isNaN(lng)) {
            return false;
        }

        // Valid ranges: latitude -90 to 90, longitude -180 to 180
        if (lat < -90 || lat > 90) {
            return false;
        }

        if (lng < -180 || lng > 180) {
            return false;
        }

        return true;
    }

    /**
     * Check if a location is in a polar region where sun may not rise/set
     * @param {number} latitude
     * @param {Date} date
     * @returns {Object} { isPolar: boolean, hasSunrise: boolean, hasSunset: boolean }
     */
    checkPolarConditions(latitude, date) {
        const lat = parseFloat(latitude);
        const times = SunCalc.getTimes(date, lat, 0); // longitude doesn't matter for this check

        return {
            isPolar: Math.abs(lat) > 66.5,
            hasSunrise: times.sunrise && !isNaN(times.sunrise.getTime()),
            hasSunset: times.sunset && !isNaN(times.sunset.getTime()),
        };
    }
}
