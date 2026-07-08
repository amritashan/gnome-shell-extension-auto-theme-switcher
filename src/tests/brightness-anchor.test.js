#!/usr/bin/env gjs
/*
 * Regression test for the "brightness snaps to the configured endpoint at
 * window start" bug (reported 2026-07-02).
 *
 * Root cause: calculateBrightness() interpolates between the CONFIGURED
 * endpoints (lightBrightness -> darkBrightness and vice versa) and never looks
 * at the brightness the screen is ACTUALLY at. If the user manually changed
 * brightness during the day (e.g. lowered a 40% day setting to 25%), the first
 * ticks of the dimming window snapped the screen back up to ~40% before
 * dimming. The brightening window has the mirror-image bug: it snaps to
 * darkBrightness first.
 *
 * The fix: at window start the loop captures each monitor's actual brightness
 * ("anchor") via DisplayController.getBrightness() and ramps anchor -> target.
 * With no anchor available (read failed), it falls back to the old behavior.
 *
 * Run: gjs -m src/tests/brightness-anchor.test.js
 */
import { BrightnessController } from '../brightnessController.js';

const MS_PER_SECOND = 1000;

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

const settings = makeSettings({
    'control-brightness': true,
    'gradual-brightness-increase-enabled': true,
    'gradual-brightness-decrease-enabled': true,
    'gradual-brightness-increase-duration': 3600,
    'gradual-brightness-decrease-duration': 3600,
    monitors: '[]',
});

const controller = new BrightnessController(settings);

// lightTime 06:00, darkTime 18:00. Dim window 17:00-18:00, brighten 05:00-06:00.
const base = new Date(2026, 6, 2, 0, 0, 0);
const lightTime = new Date(base.getTime() + 6 * 3600 * MS_PER_SECOND);
const darkTime = new Date(base.getTime() + 18 * 3600 * MS_PER_SECOND);
controller.setTimes(lightTime, darkTime);

const dimStart = new Date(darkTime.getTime() - 3600 * MS_PER_SECOND);      // 17:00
const dimMid = new Date(darkTime.getTime() - 1800 * MS_PER_SECOND);        // 17:30
const brightenStart = new Date(lightTime.getTime() - 3600 * MS_PER_SECOND); // 05:00
const brightenMid = new Date(lightTime.getTime() - 1800 * MS_PER_SECOND);   // 05:30

// --- 1) Dimming ramps from the anchor (actual brightness), not lightBrightness
assertEqual(
    controller.calculateBrightness(dimStart, 40, 20, 3600, 3600, 25),
    25, 'dim window start with anchor 25 starts at 25 (not the configured 40)');
assertEqual(
    controller.calculateBrightness(dimMid, 40, 20, 3600, 3600, 30),
    25, 'dim window midpoint with anchor 30 is halfway to dark target (25)');

// --- 2) Brightening ramps from the anchor, not darkBrightness
assertEqual(
    controller.calculateBrightness(brightenStart, 80, 20, 3600, 3600, 60),
    60, 'brighten window start with anchor 60 starts at 60 (not the configured 20)');
assertEqual(
    controller.calculateBrightness(brightenMid, 80, 20, 3600, 3600, 60),
    70, 'brighten window midpoint with anchor 60 is halfway to light target (70)');

// --- 3) No anchor -> legacy behavior (configured endpoints)
assertEqual(
    controller.calculateBrightness(dimStart, 40, 20, 3600, 3600, null),
    40, 'dim window start without anchor falls back to lightBrightness');
assertEqual(
    controller.calculateBrightness(brightenStart, 80, 20, 3600, 3600),
    20, 'brighten window start with anchor omitted falls back to darkBrightness');

// --- 4) Anchor already past the target: ramp smoothly TOWARD the target,
//        never away from it. User at 15%, dark target 25 -> gentle rise.
assertEqual(
    controller.calculateBrightness(dimStart, 40, 25, 3600, 3600, 15),
    15, 'dim window start with anchor below dark target stays at anchor');
assertEqual(
    controller.calculateBrightness(dimMid, 40, 25, 3600, 3600, 15),
    20, 'dim window midpoint ramps anchor 15 toward dark target 25 (20)');

// --- 5) Anchor capture from the actual display, and fallback when it fails
const monitorsJson = JSON.stringify([{
    id: 'builtin', name: 'Built-in Display', enabled: true, initialized: true,
    lightBrightness: 40, darkBrightness: 20,
}]);

async function testAnchorCapture() {
    if (typeof controller._captureTransitionAnchors !== 'function' ||
        typeof controller.getTransitionAnchor !== 'function') {
        failures++;
        printerr('FAIL: _captureTransitionAnchors/getTransitionAnchor not implemented');
        return;
    }

    // Successful read: anchor is the display's actual brightness
    const okSettings = makeSettings({ ...settings._v, monitors: monitorsJson });
    const okController = new BrightnessController(okSettings);
    okController.setTimes(lightTime, darkTime);
    okController._controllerCache.set('builtin', Promise.resolve({
        getBrightness: async () => 25,
        setBrightness: async () => true,
    }));
    await okController._captureTransitionAnchors();
    assertEqual(okController.getTransitionAnchor('builtin'), 25,
        'anchor capture reads actual brightness from the display controller');

    // Failed read: no anchor stored, calculateBrightness falls back
    const badSettings = makeSettings({ ...settings._v, monitors: monitorsJson });
    const badController = new BrightnessController(badSettings);
    badController.setTimes(lightTime, darkTime);
    badController._controllerCache.set('builtin', Promise.resolve({
        getBrightness: async () => null,
        setBrightness: async () => true,
    }));
    await badController._captureTransitionAnchors();
    assertEqual(badController.getTransitionAnchor('builtin'), null,
        'failed brightness read leaves no anchor (falls back to legacy ramp)');
}

// --- 6) End to end: inside a real dim window, updateBrightness() writes the
//        anchored value, not the configured-endpoint value.
async function testUpdateUsesAnchor() {
    if (typeof controller._captureTransitionAnchors !== 'function') {
        return; // already reported missing above
    }

    const now = new Date();
    const e2eSettings = makeSettings({ ...settings._v, monitors: monitorsJson });
    const e2e = new BrightnessController(e2eSettings);
    // Dim window: darkTime is 900s away, duration 3600s -> progress 0.75.
    e2e.setTimes(
        new Date(now.getTime() - 10 * 3600 * MS_PER_SECOND),
        new Date(now.getTime() + 900 * MS_PER_SECOND));

    const writes = [];
    e2e._controllerCache.set('builtin', Promise.resolve({
        getBrightness: async () => 25,
        setBrightness: async (v) => { writes.push(v); return true; },
    }));

    await e2e._captureTransitionAnchors();
    await e2e.updateBrightness();

    // anchor 25 -> dark 20 at progress 0.75 => 25 + (20-25)*0.75 = 21.25 -> 21
    assertEqual(writes[0], 21,
        'updateBrightness writes the anchored ramp value (21), not the configured ramp (35)');
}

// --- 7) Cleanup safety: a pending anchor-capture/update chain that resolves
//        AFTER cleanup() (extension disabled mid-read) must be a silent no-op,
//        not a null-settings crash. EGO reviewers reject sloppy disable paths.
async function testNoWorkAfterCleanup() {
    const s = makeSettings({ ...settings._v, monitors: monitorsJson });
    const c = new BrightnessController(s);
    const now = new Date();
    c.setTimes(
        new Date(now.getTime() - 10 * 3600 * MS_PER_SECOND),
        new Date(now.getTime() + 900 * MS_PER_SECOND));

    const writes = [];
    c._controllerCache.set('builtin', Promise.resolve({
        getBrightness: async () => 25,
        setBrightness: async (v) => { writes.push(v); return true; },
    }));

    c.cleanup();

    let threw = false;
    try {
        await c._captureTransitionAnchors();
        await c.updateBrightness();
    } catch (e) {
        threw = true;
        printerr(`   post-cleanup call rejected with: ${e.message || e}`);
    }
    assertEqual(threw, false, 'capture/update after cleanup() resolve without throwing');
    assertEqual(writes.length, 0, 'no brightness writes happen after cleanup()');
}

await testAnchorCapture();
await testUpdateUsesAnchor();
await testNoWorkAfterCleanup();

if (failures > 0) {
    printerr(`\n${failures} assertion(s) failed`);
    imports.system.exit(1);
} else {
    print('\nAll assertions passed');
}
