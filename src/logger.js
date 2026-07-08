/**
 * Gated debug logging.
 *
 * Routine diagnostic output goes through debugLog/debugWarn, which only write
 * to the journal when the 'debug-logging' setting is on (toggle in the prefs
 * Status tab). Keeps the journal quiet in normal operation — EGO review
 * guideline "No excessive logging" — while still letting a user flip the
 * switch to capture full diagnostics without reinstalling.
 *
 * console.error stays in the codebase ungated, reserved for genuine failures.
 *
 * Both the extension and the prefs process call setDebugLogging() at startup
 * (and on settings change) since they run in separate processes.
 */

let _debug = false;

export function setDebugLogging(enabled) {
    _debug = enabled;
}

export function debugLog(...args) {
    if (_debug) {
        console.log(...args);
    }
}

export function debugWarn(...args) {
    if (_debug) {
        console.warn(...args);
    }
}
