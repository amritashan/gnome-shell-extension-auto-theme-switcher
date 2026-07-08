#!/usr/bin/env gjs
/*
 * Test for the gated debug logger (EGO-A-004 "no excessive logging").
 * debugLog/debugWarn must be silent unless debug logging is enabled.
 *
 * GJS's console object and its methods are read-only, so interception happens
 * one layer down: console.* is emitted through GLib structured logging, and a
 * custom log writer counts what actually gets written. print()/printerr()
 * bypass GLib logging, so the test's own output is unaffected.
 *
 * Run: gjs -m src/tests/logger.test.js
 */
import GLib from 'gi://GLib';
import { setDebugLogging, debugLog, debugWarn } from '../logger.js';

let written = 0;
GLib.log_set_writer_func(() => {
    written++;
    return GLib.LogWriterOutput.HANDLED;
});

let failures = 0;
function assertEqual(actual, expected, msg) {
    if (actual !== expected) {
        failures++;
        printerr(`FAIL: ${msg}\n   expected ${expected}, got ${actual}`);
    } else {
        print(`ok: ${msg} (= ${actual})`);
    }
}

// Default: gated off — nothing is written
debugLog('hidden');
debugWarn('hidden');
assertEqual(written, 0, 'debugLog/debugWarn silent by default');

// Enabled: both pass through to the journal
setDebugLogging(true);
debugLog('visible');
debugWarn('visible');
assertEqual(written, 2, 'debugLog and debugWarn write when enabled');

// Disabled again: silent again
setDebugLogging(false);
debugLog('hidden');
debugWarn('hidden');
assertEqual(written, 2, 'silent again after re-disable');

if (failures > 0) {
    printerr(`\n${failures} assertion(s) failed`);
    imports.system.exit(1);
} else {
    print('\nAll assertions passed');
}
