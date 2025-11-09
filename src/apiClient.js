import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

export class APIClient {
    constructor() {
        this.latitude = null;
        this.longitude = null;
        this.locationName = null;
    }

    async getApiData() {
        try {
            const session = new Soup.Session();
            const locationMessage = Soup.Message.new('GET', 'https://ipinfo.io/loc');
            const locationBytes = await session.send_and_read_async(
                locationMessage,
                GLib.PRIORITY_DEFAULT,
                null
            );
            const location = new TextDecoder().decode(locationBytes.get_data()).trim();
            if (!location) return null;

            const [latitude, longitude] = location.split(',');

            this.latitude = latitude;
            this.longitude = longitude;

            const url = `https://api.sunrisesunset.io/json?lat=${latitude}&lng=${longitude}`;
            const apiMessage = Soup.Message.new('GET', url);
            const apiBytes = await session.send_and_read_async(
                apiMessage,
                GLib.PRIORITY_DEFAULT,
                null
            );
            const apiData = JSON.parse(new TextDecoder().decode(apiBytes.get_data()));

            try {
                const geoUrl = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=10`;
                const geoMessage = Soup.Message.new('GET', geoUrl);
                geoMessage.request_headers.append('User-Agent', 'GNOME-Auto-Theme-Switcher/1.0');
                const geoBytes = await session.send_and_read_async(
                    geoMessage,
                    GLib.PRIORITY_DEFAULT,
                    null
                );
                const geoData = JSON.parse(new TextDecoder().decode(geoBytes.get_data()));

                if (geoData.address) {
                    const parts = [];
                    if (geoData.address.city) parts.push(geoData.address.city);
                    else if (geoData.address.town) parts.push(geoData.address.town);
                    else if (geoData.address.village) parts.push(geoData.address.village);

                    if (geoData.address.state) parts.push(geoData.address.state);
                    if (geoData.address.country) parts.push(geoData.address.country);

                    this.locationName = parts.join(', ') || 'Unknown';
                } else {
                    this.locationName = 'Unknown';
                }
            } catch (geoError) {
                console.error(`ThemeSwitcher: Failed to fetch location name: ${geoError}`);
                this.locationName = 'Unknown';
            }

            return apiData;
        } catch (e) {
            console.error(`ThemeSwitcher: Failed to fetch API data: ${e}`);
            return null;
        }
    }

    async getApiDataForCoordinates(latitude, longitude) {
        try {
            console.log(`ThemeSwitcher: Fetching sun times for manual coordinates: ${latitude}, ${longitude}`);
            const session = new Soup.Session();

            this.latitude = latitude;
            this.longitude = longitude;

            const url = `https://api.sunrisesunset.io/json?lat=${latitude}&lng=${longitude}`;
            const apiMessage = Soup.Message.new('GET', url);
            const apiBytes = await session.send_and_read_async(
                apiMessage,
                GLib.PRIORITY_DEFAULT,
                null
            );
            const apiData = JSON.parse(new TextDecoder().decode(apiBytes.get_data()));

            try {
                const geoUrl = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=10`;
                const geoMessage = Soup.Message.new('GET', geoUrl);
                geoMessage.request_headers.append('User-Agent', 'GNOME-Auto-Theme-Switcher/1.0');
                const geoBytes = await session.send_and_read_async(
                    geoMessage,
                    GLib.PRIORITY_DEFAULT,
                    null
                );
                const geoData = JSON.parse(new TextDecoder().decode(geoBytes.get_data()));

                if (geoData.address) {
                    const parts = [];
                    if (geoData.address.city) parts.push(geoData.address.city);
                    else if (geoData.address.town) parts.push(geoData.address.town);
                    else if (geoData.address.village) parts.push(geoData.address.village);

                    if (geoData.address.state) parts.push(geoData.address.state);
                    if (geoData.address.country) parts.push(geoData.address.country);

                    this.locationName = parts.join(', ') || 'Manual Coordinates';
                } else {
                    this.locationName = 'Manual Coordinates';
                }
            } catch (geoError) {
                console.error(`ThemeSwitcher: Failed to fetch location name: ${geoError}`);
                this.locationName = 'Manual Coordinates';
            }

            return apiData;
        } catch (e) {
            console.error(`ThemeSwitcher: Failed to fetch API data for manual coordinates: ${e}`);
            return null;
        }
    }
}
