/**
 * APIClient - Location detection via external APIs
 *
 * This client is used ONLY for one-time location detection when the user
 * clicks the "Auto-Detect Location" button in preferences. It is NOT used
 * for regular extension operation.
 *
 * APIs used:
 * - ipinfo.io: IP-based geolocation (has daily rate limits - use sparingly)
 * - nominatim.openstreetmap.org: Reverse geocoding for location name
 *
 * IMPORTANT: These APIs have rate limits. The extension is designed to call
 * them only when explicitly requested by the user, not automatically.
 */

import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

export class APIClient {
    constructor() {
        this._session = new Soup.Session();
    }

    /**
     * Safely get HTTP status code from a Soup.Message
     * GJS/Soup3 may throw if the status code isn't in the Soup.Status enum
     * @private
     */
    _getStatusCode(message) {
        try {
            return message.get_status();
        } catch (e) {
            // If get_status() throws (e.g., 429 not in enum), try to extract the code
            // from the error message or return a generic error code
            const match = e.message?.match(/(\d{3})/);
            if (match) {
                return parseInt(match[1], 10);
            }
            console.error(`APIClient: Failed to get status code: ${e.message || e}`);
            return 0; // Unknown status
        }
    }

    destroy() {
        if (this._session) {
            this._session.abort();
            this._session = null;
        }
    }

    /**
     * Detect user's location using IP-based geolocation
     *
     * WARNING: ipinfo.io has rate limits (1000 requests/day for free tier).
     * This method should only be called when the user explicitly requests it.
     *
     * @returns {Promise<{latitude: string, longitude: string, locationName: string}|null>}
     */
    async detectLocation() {
        let currentUrl = null;

        try {
            // Step 1: Get coordinates from IP
            currentUrl = 'https://ipinfo.io/loc';
            console.log('APIClient: Requesting location from ipinfo.io...');

            const locationMessage = Soup.Message.new('GET', currentUrl);
            const locationBytes = await this._session.send_and_read_async(
                locationMessage,
                GLib.PRIORITY_DEFAULT,
                null
            );

            const statusCode = this._getStatusCode(locationMessage);

            if (statusCode === 429) {
                const errorMsg = 'Rate limit exceeded. ipinfo.io allows limited daily requests. Please try again tomorrow or enter coordinates manually.';
                console.error(`APIClient: ${errorMsg}`);
                throw new Error(errorMsg);
            }

            if (statusCode !== 200) {
                const errorMsg = `ipinfo.io returned HTTP ${statusCode}. Unable to detect location.`;
                console.error(`APIClient: ${errorMsg}`);
                throw new Error(errorMsg);
            }

            const locationData = new TextDecoder().decode(locationBytes.get_data()).trim();

            if (!locationData || !locationData.includes(',')) {
                const errorMsg = 'ipinfo.io returned invalid location data.';
                console.error(`APIClient: ${errorMsg}`);
                throw new Error(errorMsg);
            }

            const [latitude, longitude] = locationData.split(',');
            console.log(`APIClient: Detected coordinates: ${latitude}, ${longitude}`);

            // Step 2: Get location name via reverse geocoding
            let locationName = 'Unknown';
            try {
                locationName = await this._reverseGeocode(latitude, longitude);
            } catch (geoError) {
                // Non-fatal - we have coordinates, location name is just nice-to-have
                console.warn(`APIClient: Reverse geocoding failed: ${geoError.message}`);
                locationName = 'Location detected';
            }

            return {
                latitude,
                longitude,
                locationName,
            };
        } catch (e) {
            const urlInfo = currentUrl ? ` (URL: ${currentUrl})` : '';
            console.error(`APIClient: Location detection failed${urlInfo}: ${e.message || e}`);
            throw e;
        }
    }

    /**
     * Get human-readable location name from coordinates using OpenStreetMap
     *
     * @param {string} latitude
     * @param {string} longitude
     * @returns {Promise<string>} Location name (e.g., "San Francisco, California, USA")
     */
    async _reverseGeocode(latitude, longitude) {
        const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=10`;

        console.log('APIClient: Requesting location name from OpenStreetMap...');

        const message = Soup.Message.new('GET', url);
        // OpenStreetMap requires a User-Agent header
        message.request_headers.append('User-Agent', 'GNOME-Auto-Theme-Switcher/1.0');

        const bytes = await this._session.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            null
        );

        const statusCode = this._getStatusCode(message);

        if (statusCode !== 200) {
            throw new Error(`OpenStreetMap returned HTTP ${statusCode}`);
        }

        const data = JSON.parse(new TextDecoder().decode(bytes.get_data()));

        if (data.address) {
            const parts = [];

            // City/town/village
            if (data.address.city) {
                parts.push(data.address.city);
            } else if (data.address.town) {
                parts.push(data.address.town);
            } else if (data.address.village) {
                parts.push(data.address.village);
            } else if (data.address.county) {
                parts.push(data.address.county);
            }

            // State/region
            if (data.address.state) {
                parts.push(data.address.state);
            }

            // Country
            if (data.address.country) {
                parts.push(data.address.country);
            }

            const locationName = parts.join(', ') || 'Unknown';
            console.log(`APIClient: Reverse geocoded location: ${locationName}`);
            return locationName;
        }

        return 'Unknown';
    }

    /**
     * Get location name for given coordinates
     * This is a public wrapper around _reverseGeocode for use when
     * coordinates are entered manually and we want to show the location name.
     *
     * @param {string} latitude
     * @param {string} longitude
     * @returns {Promise<string>}
     */
    async getLocationName(latitude, longitude) {
        try {
            return await this._reverseGeocode(latitude, longitude);
        } catch (e) {
            console.warn(`APIClient: Failed to get location name: ${e.message}`);
            return 'Unknown';
        }
    }
}
