#!/usr/bin/env gjs
/*
 * Regression test for the frozen "Time to Next Switch" countdown
 * (reported 2026-07-02: showed 12h 57m when the real gap was ~56m).
 *
 * Root cause: secondsToNextEvent was computed ONCE when the schedule was
 * established (extensionController._scheduleNextChangeEvent) and stored as a
 * relative value. The prefs Status tab then re-anchored that stale delta to a
 * fresh "now" every 5 seconds, so the countdown never advanced — it perpetually
 * showed the gap as of the last theme switch.
 *
 * The fix: debug info carries the ABSOLUTE event timestamp and the remaining
 * seconds are derived at read time via secondsUntilEvent().
 *
 * Run: gjs -m src/tests/next-event-countdown.test.js
 */

let failures = 0;
function assertEqual(actual, expected, msg) {
    if (actual !== expected) {
        failures++;
        printerr(`FAIL: ${msg}\n   expected ${expected}, got ${actual}`);
    } else {
        print(`ok: ${msg} (= ${actual})`);
    }
}

const mod = await import('../timeCalculator.js');
const secondsUntilEvent = mod.secondsUntilEvent;

if (typeof secondsUntilEvent !== 'function') {
    printerr('FAIL: secondsUntilEvent is not exported from timeCalculator.js');
    imports.system.exit(1);
}

// The bug scenario: schedule computed at 05:06, dark switch at 18:03 (12h57m).
// Read at 17:07 — the countdown must show the REAL remaining 56m, not 12h57m.
const schedTime = new Date(2026, 6, 2, 5, 6, 0).getTime();
const eventTime = new Date(2026, 6, 2, 18, 3, 0).getTime();
const readTime = new Date(2026, 6, 2, 17, 7, 0).getTime();

assertEqual(secondsUntilEvent(eventTime, schedTime), 46620,
    'at schedule time the full 12h57m remains');
assertEqual(secondsUntilEvent(eventTime, readTime), 3360,
    'read at 17:07 yields the true 56m remaining, not the stale 12h57m');

// Past events clamp to zero (never a negative countdown)
assertEqual(secondsUntilEvent(eventTime, eventTime + 5000), 0,
    'event in the past clamps to 0');

// Missing/invalid timestamps are harmless
assertEqual(secondsUntilEvent(0, readTime), 0, 'timestamp 0 yields 0');
assertEqual(secondsUntilEvent(null, readTime), 0, 'null timestamp yields 0');
assertEqual(secondsUntilEvent(NaN, readTime), 0, 'NaN timestamp yields 0');

// Sub-second remainders round to the nearest second
assertEqual(secondsUntilEvent(readTime + 1499, readTime), 1, '1499ms rounds to 1s');

if (failures > 0) {
    printerr(`\n${failures} assertion(s) failed`);
    imports.system.exit(1);
} else {
    print('\nAll assertions passed');
}
