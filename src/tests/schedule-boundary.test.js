#!/usr/bin/env gjs
/*
 * Regression test for the theme flip-back storm at the switch boundary
 * (issue #10, reported 2026-05-13: desktop freezes for seconds to minutes and
 * the theme flickers light<->dark when the scheduled switch fires).
 *
 * Root cause: _scheduleNextChangeEvent armed the boundary timer with
 * Math.round((nextEventTime - now)/1000) and NO lower clamp, so the timer
 * could fire up to ~0.5s BEFORE the boundary. The callback applied the
 * stale closure's target theme, then re-derived the mode from a fresh `now`
 * (still pre-boundary) and applied the OPPOSITE theme, re-arming with a
 * 0-second timer. Measured: 75k+ gtk-theme/color-scheme rewrites in 400ms.
 *
 * The fix: mode + delay come from one pure helper, computeNextEvent(), whose
 * delay is clamped to >= 1s, and the timer callback only re-derives (single
 * writer) instead of also applying the stale closure value.
 *
 * Run: gjs -m src/tests/schedule-boundary.test.js
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
const computeNextEvent = mod.computeNextEvent;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// A plausible day: light at 06:30, dark at 18:45 (absolute ms timestamps)
const base = Date.UTC(2026, 4, 13); // 2026-05-13 00:00 UTC
const lightTime = base + (6 * 60 + 30) * 60 * 1000;
const darkTime = base + (18 * 60 + 45) * 60 * 1000;

// --- Mode derivation ---
let r = computeNextEvent(lightTime + 60_000, lightTime, darkTime);
assertEqual(r.isDark, false, 'one minute after lightTime is day');
assertEqual(r.nextEventTimestamp, darkTime, 'day period schedules the dark switch');

r = computeNextEvent(darkTime, lightTime, darkTime);
assertEqual(r.isDark, true, 'exactly at darkTime is night');
assertEqual(r.nextEventTimestamp, lightTime + MS_PER_DAY, 'night schedules tomorrow\'s light switch');

r = computeNextEvent(lightTime - 60_000, lightTime, darkTime);
assertEqual(r.isDark, true, 'one minute before lightTime is night');
assertEqual(r.nextEventTimestamp, lightTime, 'early morning schedules today\'s light switch');

// --- The issue #10 clamp: a timer firing moments early must never re-arm at 0s ---
r = computeNextEvent(darkTime - 400, lightTime, darkTime);
assertEqual(r.isDark, false, '400ms before darkTime is still day');
assertEqual(r.secondsToNextEvent, 1, '400ms gap arms a 1s timer, never 0 (Math.round would give 0)');

r = computeNextEvent(darkTime - 1, lightTime, darkTime);
assertEqual(r.secondsToNextEvent, 1, '1ms gap still arms a 1s timer');

r = computeNextEvent(darkTime - 90_000, lightTime, darkTime);
assertEqual(r.secondsToNextEvent, 90, 'normal gaps are unaffected by the clamp');

// --- Boundary walk: mode must be monotonic across the switch (no flip-back) ---
// Simulate the fixed scheduler: at each firing, re-derive the mode for `now`,
// apply it, then sleep secondsToNextEvent. Starting just before the boundary
// (the early-fire state that caused the storm), the applied-mode sequence must
// go light -> dark exactly once, with no dark -> light reversal.
{
    let now = darkTime - 400;
    let applied = [];
    let currentDark = null;
    for (let i = 0; i < 5 && now < darkTime + 5000; i++) {
        const step = computeNextEvent(now, lightTime, darkTime);
        if (currentDark !== step.isDark) {
            currentDark = step.isDark;
            applied.push(step.isDark ? 'dark' : 'light');
        }
        if (step.isDark) break; // steady state (night) reached
        now += step.secondsToNextEvent * 1000;
    }
    assertEqual(applied.join('->'), 'light->dark', 'boundary crossing applies each mode once, no flip-back');
}

if (failures) {
    printerr(`\n${failures} assertion(s) failed`);
    imports.system.exit(1);
} else {
    print('\nAll assertions passed');
}
