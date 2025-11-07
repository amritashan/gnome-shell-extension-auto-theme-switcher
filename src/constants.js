// Shared constants between extension and preferences
// This file ensures that timing values stay in sync

// Time conversion constants
export const MS_PER_SECOND = 1000;
export const SECONDS_PER_MINUTE = 60;
export const MINUTES_PER_HOUR = 60;
export const HOURS_PER_DAY = 24;
export const MS_PER_DAY = HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND; // 86400000

// Brightness update interval
export const BRIGHTNESS_UPDATE_INTERVAL_SECONDS = 600; // 10 minutes
export const BRIGHTNESS_UPDATE_INTERVAL_MS = BRIGHTNESS_UPDATE_INTERVAL_SECONDS * MS_PER_SECOND;

// API refresh interval (how often to fetch new sunrise/sunset times from API)
export const API_REFRESH_INTERVAL_SECONDS = 900; // 15 minutes

// Debug panel refresh intervals
export const DEBUG_TIME_UPDATE_INTERVAL_SECONDS = 1; // Update countdown every second
export const DEBUG_INFO_REFRESH_INTERVAL_SECONDS = 5; // Refresh debug info every 5 seconds

// Debounce interval for forced refresh when countdown goes negative
export const FORCE_REFRESH_DEBOUNCE_MS = 2000; // 2 seconds

// Resume delay after system suspend/hibernate
export const RESUME_DELAY_SECONDS = 2; // Wait 2 seconds after resume before updating

// Gradual brightness transition duration options (in seconds)
// Value 0 means "Off" (disabled)
export const BRIGHTNESS_TRANSITION_DURATIONS = [
    { label: 'Off', value: 0 },
    { label: '15 minutes', value: 900 },
    { label: '30 minutes', value: 1800 },
    { label: '1 hour', value: 3600 },
    { label: '1.5 hours', value: 5400 },
    { label: '2 hours', value: 7200 },
    { label: '2.5 hours', value: 9000 },
    { label: '3 hours', value: 10800 }
];
