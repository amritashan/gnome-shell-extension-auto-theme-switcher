export class TimeCalculator {
    parseTime(timeStr) {
        // Creates a Date object for a time string like "5:44:30 AM"
        const now = new Date();
        const [time, period] = timeStr.split(' ');
        let [hours, minutes, seconds] = time.split(':').map(Number);

        if (period === 'PM' && hours < 12) {
            hours += 12;
        }
        if (period === 'AM' && hours === 12) {
            hours = 0;
        }
        return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, seconds);
    }

    parseTriggerTime(trigger, apiResults, now, mode, settings) {
        if (trigger === 'custom') {
            const customTimeSetting = mode === 'light' ? 'custom-light-time' : 'custom-dark-time';
            const customTime = settings.get_string(customTimeSetting);
            return this.parseCustomTime(customTime, now);
        }

        let apiField;
        if (trigger === 'first-light') {
            apiField = 'first_light';
        } else if (trigger === 'dawn') {
            apiField = 'dawn';
        } else if (trigger === 'sunrise') {
            apiField = 'sunrise';
        } else if (trigger === 'solar-noon') {
            apiField = 'solar_noon';
        } else if (trigger === 'golden-hour') {
            apiField = 'golden_hour';
        } else if (trigger === 'sunset') {
            apiField = 'sunset';
        } else if (trigger === 'dusk') {
            apiField = 'dusk';
        } else if (trigger === 'last-light') {
            apiField = 'last_light';
        } else {
            console.error(`ThemeSwitcher: Unknown trigger '${trigger}', using default`);
            apiField = mode === 'light' ? 'sunrise' : 'sunset';
        }

        return this.parseTime(apiResults[apiField]);
    }

    parseCustomTime(timeString, now) {
        const timeParts = timeString.split(':');
        if (timeParts.length >= 2) {
            const h = parseInt(timeParts[0], 10);
            const m = parseInt(timeParts[1], 10);
            if (!isNaN(h) && !isNaN(m) && h >= 0 && h < 24 && m >= 0 && m < 60) {
                return new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0);
            } else {
                console.error(`ThemeSwitcher: Invalid custom time format: ${timeString}`);
                return null;
            }
        } else {
            console.error(`ThemeSwitcher: Invalid custom time format: ${timeString}`);
            return null;
        }
    }
}
