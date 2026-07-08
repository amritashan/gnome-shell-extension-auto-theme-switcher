#!/usr/bin/env gjs
/*
 * Regression test for the "brightness jumps at window start" bug.
 *
 * Root cause: scheduleBrightnessUpdates() starts/stops the gradual loop using
 * the GLOBAL transition duration, but _updateSingleMonitor used to compute the
 * ramp with the PER-MONITOR `increaseDuration`/`decreaseDuration` snapshot
 * (`monitor.increaseDuration ?? global`). Those per-monitor fields are a stale
 * one-time copy of the default that the UI never updates, so once the user
 * changed the global duration the two paths disagreed and the loop's first tick
 * jumped partway up the curve instead of starting at darkBrightness.
 *
 * Reproduces the exact numbers seen in the journal on 2026-06-24:
 *   global increase = 1800s (30m), per-monitor increaseDuration = 7200s (2h)
 *   Dell  dark=40 light=87  ->  jumped to 75% at window start (should be 40%)
 *   Built dark=11 light=40  ->  jumped to 33% at window start (should be 11%)
 *
 * Run: gjs -m src/tests/brightness-window-start.test.js
 */
import GLib from 'gi://GLib';
import { BrightnessController } from '../brightnessController.js';

const MS_PER_SECOND = 1000;

// Minimal fake GSettings backed by a plain object.
function makeSettings(values) {
    return {
        _v: values,
        get_boolean: (k) => !!values[k],
        get_int: (k) => values[k] | 0,
        get_string: (k) => String(values[k] ?? ''),
        set_string: () => {},
        connect: () => 0,
        disconnect: () => {},
    };
}

let failures = 0;
function assertEqual(actual, expected, msg) {
    if (actual !== expected) {
        failures++;
        printerr(`FAIL: ${msg}\n   expected ${expected}, got ${actual}`);
    } else {
        print(`ok: ${msg} (= ${actual})`);
    }
}

// --- Scenario from the journal ------------------------------------------------
const GLOBAL_INCREASE = 1800;   // 30 min, what the user set in prefs
const GLOBAL_DECREASE = 3600;   // 1 h
const STALE_PER_MONITOR = 7200; // 2 h, baked into the monitor at detection time

const settings = makeSettings({
    'control-brightness': true,
    'gradual-brightness-increase-enabled': true,
    'gradual-brightness-decrease-enabled': true,
    'gradual-brightness-increase-duration': GLOBAL_INCREASE,
    'gradual-brightness-decrease-duration': GLOBAL_DECREASE,
    monitors: '[]',
});

const controller = new BrightnessController(settings);

// lightTime = today 05:02:53 (sunrise), darkTime = today 20:00 (evening).
const base = new Date(2026, 5, 24, 0, 0, 0);
const lightTime = new Date(base.getTime() + (5 * 3600 + 2 * 60 + 53) * MS_PER_SECOND);
const darkTime = new Date(base.getTime() + 20 * 3600 * MS_PER_SECOND);
controller.setTimes(lightTime, darkTime);

// The scheduler starts the brightening loop here: lightTime - GLOBAL duration.
const windowStart = new Date(lightTime.getTime() - GLOBAL_INCREASE * MS_PER_SECOND);

// 1) The fix: durations resolve to the GLOBAL values, ignoring the stale
//    per-monitor snapshot.
const resolved = controller._resolveDurations({
    increaseDuration: STALE_PER_MONITOR,
    decreaseDuration: STALE_PER_MONITOR,
});
assertEqual(resolved.increaseDuration, GLOBAL_INCREASE,
    '_resolveDurations ignores stale per-monitor increaseDuration');
assertEqual(resolved.decreaseDuration, GLOBAL_DECREASE,
    '_resolveDurations ignores stale per-monitor decreaseDuration');

// 2) The core invariant: at the scheduler's window start, the brightness the
//    loop applies must equal darkBrightness (progress 0). With the bug it was 75/33.
const dell = controller.calculateBrightness(
    windowStart, /*light*/ 87, /*dark*/ 40,
    resolved.increaseDuration, resolved.decreaseDuration);
assertEqual(dell, 40, 'Dell starts the brightening window at darkBrightness (not the 75% jump)');

const builtin = controller.calculateBrightness(
    windowStart, /*light*/ 40, /*dark*/ 11,
    resolved.increaseDuration, resolved.decreaseDuration);
assertEqual(builtin, 11, 'Built-in starts the brightening window at darkBrightness (not the 33% jump)');

// 3) Guard: demonstrate the OLD behaviour (using the stale 2h duration) is what
//    produced the jump, so this test genuinely pins the regression.
const dellBuggy = controller.calculateBrightness(
    windowStart, 87, 40, STALE_PER_MONITOR, STALE_PER_MONITOR);
assertEqual(dellBuggy, 75, 'sanity: stale per-monitor duration reproduces the original 75% jump');

if (failures > 0) {
    printerr(`\n${failures} assertion(s) failed`);
    imports.system.exit(1);
} else {
    print('\nAll assertions passed');
}
