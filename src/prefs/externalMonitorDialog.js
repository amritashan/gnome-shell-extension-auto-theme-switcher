import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import GLib from 'gi://GLib';
import { DisplayManager } from './displayManager.js';
import { DdcutilDisplay, probeDisplayController } from '../displayController.js';
import { BrightnessSliderRow } from './brightnessSliderRow.js';
import { BRIGHTNESS_TRANSITION_DURATIONS } from '../constants.js';
import { debugLog, debugWarn } from '../logger.js';

/**
 * Dialog window for configuring all monitor brightness control.
 * Allows users to:
 * - Configure built-in display brightness
 * - Detect external monitors
 * - Enable/disable brightness control per monitor
 * - Configure light/dark brightness for each monitor
 * - Initialize new monitors with current brightness
 */
export class MonitorConfigDialog {
    /**
     * @param {Gtk.Window} parentWindow - Parent preferences window
     * @param {Gio.Settings} settings - Extension settings
     */
    constructor(parentWindow, settings) {
        this.parentWindow = parentWindow;
        this.settings = settings;
        this.displayManager = new DisplayManager(settings);

        this.dialog = null;
        this.detectionInProgress = false;
        this.monitorRows = new Map();  // Map of monitor ID to UI row
        this.monitors = new Map();  // Map of monitor ID to monitor object (current state)
        this.ddcutilInstalled = false;  // Track ddcutil installation status
        this._pendingTimeouts = [];  // Track pending timeouts for cleanup
        this._brightnessSliders = [];  // Track BrightnessSliderRow instances for cleanup
    }

    /**
     * Show the monitor configuration dialog.
     */
    show() {
        this._createDialog();
        this._buildUI();

        // Show dialog immediately (don't wait for monitor detection)
        this.dialog.present();

        // Load monitors in background (non-blocking)
        this._loadAndShowMonitors();
    }

    /**
     * Create the dialog window.
     * @private
     */
    _createDialog() {
        this.dialog = new Adw.Window({
            title: 'Monitor Configuration',
            modal: true,
            transient_for: this.parentWindow,
            default_width: 700,
            default_height: 600,
        });

        // Toast overlay for showing notifications
        this.toastOverlay = new Adw.ToastOverlay();

        // Main content box
        this.contentBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 0,
        });

        // Set up the hierarchy: Window -> ToastOverlay -> ContentBox
        this.toastOverlay.set_child(this.contentBox);
        this.dialog.set_content(this.toastOverlay);

        // Clean up resources when dialog closes
        this.dialog.connect('close-request', () => {
            this._cleanup();
            return false;
        });
    }

    /**
     * Clean up all resources when dialog closes.
     * @private
     */
    _cleanup() {
        // Remove all pending timeouts
        for (const timeoutId of this._pendingTimeouts) {
            GLib.Source.remove(timeoutId);
        }
        this._pendingTimeouts = [];

        // Destroy all BrightnessSliderRow instances
        for (const slider of this._brightnessSliders) {
            slider.destroy();
        }
        this._brightnessSliders = [];

        // Clear maps
        this.monitorRows.clear();
        this.monitors.clear();
    }

    /**
     * Build the dialog UI structure.
     * @private
     */
    _buildUI() {
        // Header bar
        const headerBar = new Adw.HeaderBar();
        this.contentBox.append(headerBar);

        // Refresh button in header
        this.refreshButton = new Gtk.Button({
            icon_name: 'view-refresh-symbolic',
            tooltip_text: 'Detect external monitors',
        });
        this.refreshButton.connect('clicked', () => this._refreshMonitors());
        headerBar.pack_start(this.refreshButton);

        // Scrolled window for monitors list
        const scrolled = new Gtk.ScrolledWindow({
            vexpand: true,
            hexpand: true,
        });
        this.contentBox.append(scrolled);

        // Main content area
        const clamp = new Adw.Clamp({
            maximum_size: 800,
            tightening_threshold: 600,
        });
        scrolled.set_child(clamp);

        this.mainBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 24,
            margin_top: 24,
            margin_bottom: 24,
            margin_start: 12,
            margin_end: 12,
        });
        clamp.set_child(this.mainBox);

        // Brightness Transitions group (global settings) - at the top
        this.transitionsGroup = new Adw.PreferencesGroup({
            title: 'Brightness Transitions',
            description: 'Gradually adjust brightness before theme changes',
        });
        this.mainBox.append(this.transitionsGroup);

        // Gradual brightening (before light mode)
        const increaseDurationRow = new Adw.ComboRow({
            title: 'Gradual brightening',
            subtitle: 'Gradually increase brightness before light mode',
        });
        const increaseDurationModel = new Gtk.StringList();
        BRIGHTNESS_TRANSITION_DURATIONS.forEach(duration => {
            increaseDurationModel.append(duration.label);
        });
        increaseDurationRow.model = increaseDurationModel;

        // Find and set the current selection (Off if disabled, otherwise the duration)
        const savedIncreaseEnabled = this.settings.get_boolean('gradual-brightness-increase-enabled');
        const savedIncreaseDuration = this.settings.get_int('gradual-brightness-increase-duration');
        if (!savedIncreaseEnabled) {
            increaseDurationRow.selected = 0; // "Off"
        } else {
            const increaseIndex = BRIGHTNESS_TRANSITION_DURATIONS.findIndex(d => d.value === savedIncreaseDuration);
            increaseDurationRow.selected = increaseIndex >= 0 ? increaseIndex : 5; // Default to 2 hours (index 5)
        }

        // Connect settings changes
        increaseDurationRow.connect('notify::selected', () => {
            const selected = increaseDurationRow.selected;
            if (selected >= 0 && selected < BRIGHTNESS_TRANSITION_DURATIONS.length) {
                const selectedValue = BRIGHTNESS_TRANSITION_DURATIONS[selected].value;
                if (selectedValue === 0) {
                    // "Off" selected
                    this.settings.set_boolean('gradual-brightness-increase-enabled', false);
                } else {
                    // Duration selected
                    this.settings.set_boolean('gradual-brightness-increase-enabled', true);
                    this.settings.set_int('gradual-brightness-increase-duration', selectedValue);
                }
            }
        });

        this.transitionsGroup.add(increaseDurationRow);

        // Gradual dimming (before dark mode)
        const decreaseDurationRow = new Adw.ComboRow({
            title: 'Gradual dimming',
            subtitle: 'Gradually decrease brightness before dark mode',
        });
        const decreaseDurationModel = new Gtk.StringList();
        BRIGHTNESS_TRANSITION_DURATIONS.forEach(duration => {
            decreaseDurationModel.append(duration.label);
        });
        decreaseDurationRow.model = decreaseDurationModel;

        // Find and set the current selection (Off if disabled, otherwise the duration)
        const savedDecreaseEnabled = this.settings.get_boolean('gradual-brightness-decrease-enabled');
        const savedDecreaseDuration = this.settings.get_int('gradual-brightness-decrease-duration');
        if (!savedDecreaseEnabled) {
            decreaseDurationRow.selected = 0; // "Off"
        } else {
            const decreaseIndex = BRIGHTNESS_TRANSITION_DURATIONS.findIndex(d => d.value === savedDecreaseDuration);
            decreaseDurationRow.selected = decreaseIndex >= 0 ? decreaseIndex : 5; // Default to 2 hours (index 5)
        }

        // Connect settings changes
        decreaseDurationRow.connect('notify::selected', () => {
            const selected = decreaseDurationRow.selected;
            if (selected >= 0 && selected < BRIGHTNESS_TRANSITION_DURATIONS.length) {
                const selectedValue = BRIGHTNESS_TRANSITION_DURATIONS[selected].value;
                if (selectedValue === 0) {
                    // "Off" selected
                    this.settings.set_boolean('gradual-brightness-decrease-enabled', false);
                } else {
                    // Duration selected
                    this.settings.set_boolean('gradual-brightness-decrease-enabled', true);
                    this.settings.set_int('gradual-brightness-decrease-duration', selectedValue);
                }
            }
        });

        this.transitionsGroup.add(decreaseDurationRow);

        // Detected Displays group (built-in display)
        this.builtinGroup = new Adw.PreferencesGroup({
            title: 'Detected Displays',
        });
        this.mainBox.append(this.builtinGroup);

        // External Monitors group (will be populated dynamically)
        this.monitorsGroup = new Adw.PreferencesGroup({
            title: 'External Monitors',
            description: 'Each monitor can have different brightness levels for light and dark modes',
        });
        this.mainBox.append(this.monitorsGroup);

        // ddcutil installation instructions expander (hidden by default)
        this._createDdcutilInstallExpander();
    }

    /**
     * Create the ddcutil installation instructions expander.
     * Similar to the brightnessctl installation expander in prefs.js.
     * @private
     */
    _createDdcutilInstallExpander() {
        this.ddcutilInstallExpander = new Adw.ExpanderRow({
            title: 'How to Install ddcutil',
            subtitle: 'Click to see installation instructions',
            show_enable_switch: false,
        });

        const installBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12,
        });

        // Introduction
        const introLabel = new Gtk.Label({
            label: 'ddcutil is required to control external monitor brightness via DDC/CI protocol. Follow ALL steps below carefully.',
            xalign: 0,
            wrap: true,
        });
        introLabel.add_css_class('dim-label');
        installBox.append(introLabel);

        // Step 1: Install ddcutil
        const step1Label = new Gtk.Label({
            label: 'Step 1: Install ddcutil',
            xalign: 0,
            wrap: true,
            margin_top: 12,
        });
        step1Label.add_css_class('heading');
        installBox.append(step1Label);

        const distroInstallNote = new Gtk.Label({
            label: 'Ubuntu/Debian: sudo apt install ddcutil\nFedora: sudo dnf install ddcutil\nArch: sudo pacman -S ddcutil\nNixOS: Add "ddcutil" to environment.systemPackages',
            xalign: 0,
            wrap: true,
        });
        distroInstallNote.add_css_class('dim-label');
        installBox.append(distroInstallNote);

        // Step 2: Load i2c-dev kernel module
        const step2Label = new Gtk.Label({
            label: 'Step 2: Load the i2c-dev kernel module',
            xalign: 0,
            wrap: true,
            margin_top: 12,
        });
        step2Label.add_css_class('heading');
        installBox.append(step2Label);

        this._addCopyableCommand(installBox, 'sudo modprobe i2c-dev');

        const bootLabel = new Gtk.Label({
            label: 'To load automatically at boot:',
            xalign: 0,
            wrap: true,
            margin_top: 6,
        });
        bootLabel.add_css_class('dim-label');
        installBox.append(bootLabel);

        this._addCopyableCommand(installBox, 'echo "i2c-dev" | sudo tee /etc/modules-load.d/i2c-dev.conf');

        const nixosModuleNote = new Gtk.Label({
            label: 'NixOS: Add to configuration.nix:\n  boot.kernelModules = [ "i2c-dev" ];',
            xalign: 0,
            wrap: true,
            margin_top: 6,
        });
        nixosModuleNote.add_css_class('dim-label');
        installBox.append(nixosModuleNote);

        // Step 3: Create i2c group and add user
        const step3Label = new Gtk.Label({
            label: 'Step 3: Set up i2c group and permissions',
            xalign: 0,
            wrap: true,
            margin_top: 12,
        });
        step3Label.add_css_class('heading');
        installBox.append(step3Label);

        const groupNote = new Gtk.Label({
            label: 'Create the i2c group (may already exist on some distros):',
            xalign: 0,
            wrap: true,
        });
        groupNote.add_css_class('dim-label');
        installBox.append(groupNote);

        this._addCopyableCommand(installBox, 'sudo groupadd -f i2c');

        const addUserNote = new Gtk.Label({
            label: 'Add your user to the i2c group:',
            xalign: 0,
            wrap: true,
            margin_top: 6,
        });
        addUserNote.add_css_class('dim-label');
        installBox.append(addUserNote);

        this._addCopyableCommand(installBox, 'sudo usermod -aG i2c $USER');

        const nixosGroupNote = new Gtk.Label({
            label: 'NixOS: Add to configuration.nix:\n  users.groups.i2c = {};\n  users.users.YOUR_USERNAME.extraGroups = [ "i2c" ];',
            xalign: 0,
            wrap: true,
            margin_top: 6,
        });
        nixosGroupNote.add_css_class('dim-label');
        installBox.append(nixosGroupNote);

        // Step 4: Create udev rule
        const step4Label = new Gtk.Label({
            label: 'Step 4: Create udev rule for device permissions',
            xalign: 0,
            wrap: true,
            margin_top: 12,
        });
        step4Label.add_css_class('heading');
        installBox.append(step4Label);

        const udevNote = new Gtk.Label({
            label: 'This ensures /dev/i2c-* devices are accessible to the i2c group:',
            xalign: 0,
            wrap: true,
        });
        udevNote.add_css_class('dim-label');
        installBox.append(udevNote);

        this._addCopyableCommand(installBox, 'echo \'KERNEL=="i2c-[0-9]*", GROUP="i2c", MODE="0660"\' | sudo tee /etc/udev/rules.d/99-i2c.rules');

        const reloadNote = new Gtk.Label({
            label: 'Reload udev rules:',
            xalign: 0,
            wrap: true,
            margin_top: 6,
        });
        reloadNote.add_css_class('dim-label');
        installBox.append(reloadNote);

        this._addCopyableCommand(installBox, 'sudo udevadm control --reload-rules && sudo udevadm trigger');

        const nixosUdevNote = new Gtk.Label({
            label: 'NixOS: Add to configuration.nix:\n  services.udev.extraRules = \'\'\n    KERNEL=="i2c-[0-9]*", GROUP="i2c", MODE="0660"\n  \'\';',
            xalign: 0,
            wrap: true,
            margin_top: 6,
        });
        nixosUdevNote.add_css_class('dim-label');
        installBox.append(nixosUdevNote);

        // Step 5: Reboot
        const step5Label = new Gtk.Label({
            label: 'Step 5: Reboot your computer',
            xalign: 0,
            wrap: true,
            margin_top: 12,
        });
        step5Label.add_css_class('heading');
        installBox.append(step5Label);

        const rebootNote = new Gtk.Label({
            label: 'IMPORTANT: A full reboot is required for all changes to take effect (group membership, kernel module, and udev rules). Logging out is not sufficient.\n\nNixOS: Run "sudo nixos-rebuild switch" then reboot.',
            xalign: 0,
            wrap: true,
        });
        rebootNote.add_css_class('dim-label');
        installBox.append(rebootNote);

        // Step 6: Verify
        const step6Label = new Gtk.Label({
            label: 'Step 6: Verify installation',
            xalign: 0,
            wrap: true,
            margin_top: 12,
        });
        step6Label.add_css_class('heading');
        installBox.append(step6Label);

        const verifyLabel = new Gtk.Label({
            label: 'After rebooting, verify the setup:',
            xalign: 0,
            wrap: true,
        });
        verifyLabel.add_css_class('dim-label');
        installBox.append(verifyLabel);

        const verifyStepsLabel = new Gtk.Label({
            label: '1. Check group membership (should show "i2c"):',
            xalign: 0,
            wrap: true,
            margin_top: 6,
        });
        verifyStepsLabel.add_css_class('dim-label');
        installBox.append(verifyStepsLabel);

        this._addCopyableCommand(installBox, 'groups | grep i2c');

        const verifyDevLabel = new Gtk.Label({
            label: '2. Check device permissions (should show group "i2c"):',
            xalign: 0,
            wrap: true,
            margin_top: 6,
        });
        verifyDevLabel.add_css_class('dim-label');
        installBox.append(verifyDevLabel);

        this._addCopyableCommand(installBox, 'ls -la /dev/i2c-*');

        const verifyDetectLabel = new Gtk.Label({
            label: '3. Detect monitors (should list your external monitors):',
            xalign: 0,
            wrap: true,
            margin_top: 6,
        });
        verifyDetectLabel.add_css_class('dim-label');
        installBox.append(verifyDetectLabel);

        this._addCopyableCommand(installBox, 'ddcutil detect');

        // Troubleshooting
        const troubleLabel = new Gtk.Label({
            label: 'Troubleshooting',
            xalign: 0,
            wrap: true,
            margin_top: 12,
        });
        troubleLabel.add_css_class('heading');
        installBox.append(troubleLabel);

        const troubleNote = new Gtk.Label({
            label: 'If "ddcutil detect" shows no monitors:\n• Ensure your monitor supports DDC/CI (most modern monitors do)\n• Check monitor OSD settings for DDC/CI option (sometimes disabled)\n• Virtual machines do not support DDC/CI\n• Some laptop displays may not work\n• Run "ddcutil environment" for detailed diagnostics',
            xalign: 0,
            wrap: true,
        });
        troubleNote.add_css_class('dim-label');
        installBox.append(troubleNote);

        this.ddcutilInstallExpander.add_row(new Adw.PreferencesRow({ child: installBox }));

        // Hidden by default - shown only when ddcutil is not installed
        this.ddcutilInstallExpander.visible = false;
    }

    /**
     * Helper to add a copyable command row.
     * @param {Gtk.Box} container - Parent container
     * @param {string} command - Command text
     * @private
     */
    _addCopyableCommand(container, command) {
        const commandBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
        });

        const commandEntry = new Gtk.Entry({
            text: command,
            editable: false,
            hexpand: true,
        });

        const copyButton = new Gtk.Button({
            label: 'Copy',
            valign: Gtk.Align.CENTER,
        });
        copyButton.connect('clicked', () => {
            const clipboard = this.parentWindow.get_display().get_clipboard();
            clipboard.set(command);
        });

        commandBox.append(commandEntry);
        commandBox.append(copyButton);
        container.append(commandBox);
    }

    /**
     * Load cached monitors and optionally refresh detection.
     * @private
     */
    async _loadAndShowMonitors() {
        this.refreshButton.set_sensitive(false);

        try {
            // Ensure migration has completed before loading monitors
            await this.displayManager.ensureMigrated();

            // Check if ddcutil is installed
            this.ddcutilInstalled = await DdcutilDisplay.checkDdcutilInstalled();

            // Load cached monitors first (includes builtin + external)
            const cachedMonitors = this.displayManager.loadCachedMonitors();

            // Display cached monitors if we have any
            if (cachedMonitors.length > 0) {
                this._displayMonitors(cachedMonitors);
            }

            // Update External Monitors section based on ddcutil status
            this._updateExternalMonitorsSection(cachedMonitors);

            // Check if we have any external monitors cached
            const externalCount = cachedMonitors.filter(m => m.type !== 'brightnessctl').length;

            if (this.ddcutilInstalled && externalCount === 0) {
                // ddcutil is installed but no external monitors cached - auto-detect
                await this._refreshMonitors();
            }

            this.refreshButton.set_sensitive(true);
        } catch (e) {
            console.error('MonitorConfigDialog: Error loading monitors:', e);
            this.refreshButton.set_sensitive(true);

            // Show error toast
            const errorToast = new Adw.Toast({
                title: `Error loading monitors: ${e.message}`,
                timeout: 5,
            });
            this.toastOverlay.add_toast(errorToast);
        }
    }

    /**
     * Update the External Monitors section based on ddcutil availability.
     * @param {Array} monitors - Current monitors array
     * @private
     */
    _updateExternalMonitorsSection(monitors) {
        const externalMonitors = monitors.filter(m => m.type !== 'brightnessctl');

        if (!this.ddcutilInstalled) {
            // ddcutil not installed - show installation instructions
            this.monitorsGroup.set_description('To control external monitors connected to this device, install ddcutil');

            // Show the install expander in the monitorsGroup
            if (!this.ddcutilInstallExpander.get_parent()) {
                this.monitorsGroup.add(this.ddcutilInstallExpander);
            }
            this.ddcutilInstallExpander.visible = true;

            // Hide refresh button when ddcutil is not available
            this.refreshButton.visible = false;
        } else {
            // ddcutil is installed - hide installation instructions
            this.ddcutilInstallExpander.visible = false;
            if (this.ddcutilInstallExpander.get_parent()) {
                this.monitorsGroup.remove(this.ddcutilInstallExpander);
            }

            // Show refresh button
            this.refreshButton.visible = true;

            if (externalMonitors.length === 0) {
                // No external monitors detected
                this.monitorsGroup.set_description('No external monitors were detected');
            } else {
                // External monitors found
                this.monitorsGroup.set_description('Each monitor can have different brightness levels for light and dark modes');
            }
        }
    }

    /**
     * Refresh monitor list by detecting monitors.
     * @private
     */
    async _refreshMonitors() {
        if (this.detectionInProgress) {
            debugLog('MonitorConfigDialog: Detection already in progress');
            return;
        }

        this.detectionInProgress = true;
        this.refreshButton.set_sensitive(false);

        // Show detecting toast
        const detectingToast = new Adw.Toast({
            title: 'Detecting external monitors...',
            timeout: 0,  // Don't auto-dismiss
        });
        this.toastOverlay.add_toast(detectingToast);

        const startTime = Date.now();

        try {
            // Ensure migration has completed
            await this.displayManager.ensureMigrated();

            // Load cached monitors first to preserve builtin
            const cachedMonitors = this.displayManager.loadCachedMonitors();
            const builtin = cachedMonitors.find(m => m.id === 'builtin');

            // Detect external monitors (does not include builtin)
            const detectedExternalMonitors = await this.displayManager.detectExternalMonitors();

            // Merge detected external monitors with cached external monitors
            const cachedExternalMonitors = cachedMonitors.filter(m => m.type !== 'brightnessctl');
            const mergedExternalMonitors = this.displayManager.mergeMonitors(
                detectedExternalMonitors,
                cachedExternalMonitors
            );

            // Build final monitor list: builtin + external monitors
            const allMonitors = [];
            if (builtin) {
                allMonitors.push(builtin);
            }
            allMonitors.push(...mergedExternalMonitors);

            // Check for newly detected monitors
            const newMonitors = allMonitors.filter(m => !m.initialized && m.type !== 'brightnessctl');
            if (newMonitors.length > 0) {
                debugLog(`MonitorConfigDialog: Found ${newMonitors.length} new external monitors`);
            }

            // Save merged list
            this.displayManager.saveMonitors(allMonitors);

            // Display all monitors
            this._displayMonitors(allMonitors);

            // Update External Monitors section
            this._updateExternalMonitorsSection(allMonitors);

            // Dismiss detecting toast and show result
            detectingToast.dismiss();
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

            if (detectedExternalMonitors.length === 0) {
                const noMonitorsToast = new Adw.Toast({
                    title: 'No external monitors detected',
                    timeout: 3,
                });
                this.toastOverlay.add_toast(noMonitorsToast);
            } else {
                const successToast = new Adw.Toast({
                    title: `Found ${detectedExternalMonitors.length} external monitor${detectedExternalMonitors.length > 1 ? 's' : ''} (${elapsed}s)`,
                    timeout: 3,
                });
                this.toastOverlay.add_toast(successToast);
            }

        } catch (e) {
            console.error(`MonitorConfigDialog: Error during detection: ${e}`);
            detectingToast.dismiss();

            const errorToast = new Adw.Toast({
                title: `Detection failed: ${e.message}`,
                timeout: 5,
            });
            this.toastOverlay.add_toast(errorToast);
        } finally {
            this.detectionInProgress = false;
            this.refreshButton.set_sensitive(true);
        }
    }

    /**
     * Display monitors in the UI.
     * @param {Array} monitors - Array of monitor objects
     * @private
     */
    _displayMonitors(monitors) {
        // Clear existing monitor rows (including any error messages)
        this.monitorRows.forEach((row, id) => {
            const monitor = this.monitors.get(id);
            if (monitor && monitor.type === 'brightnessctl') {
                this.builtinGroup.remove(row);
            } else {
                this.monitorsGroup.remove(row);
            }
        });
        this.monitorRows.clear();
        this.monitors.clear();

        // Also clear any standalone rows (like error messages)
        let child = this.monitorsGroup.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this.monitorsGroup.remove(child);
            child = next;
        }

        // Separate built-in from external monitors
        const builtinMonitor = monitors.find(m => m.type === 'brightnessctl');
        const externalMonitors = monitors.filter(m => m.type !== 'brightnessctl');

        // Add built-in monitor to its own section
        if (builtinMonitor) {
            const row = this._createBuiltinMonitorRow(builtinMonitor);
            this.builtinGroup.add(row);
            this.monitorRows.set(builtinMonitor.id, row);
            this.monitors.set(builtinMonitor.id, builtinMonitor);
        }

        // Add external monitors to their section
        for (const monitor of externalMonitors) {
            const row = this._createMonitorRow(monitor);
            this.monitorsGroup.add(row);
            this.monitorRows.set(monitor.id, row);
            this.monitors.set(monitor.id, monitor);  // Track monitor object
        }
    }

    /**
     * Create a specialized UI row for the built-in monitor.
     * Unlike external monitors, this always shows brightness controls and doesn't use expander.
     * @param {Object} monitor - Built-in monitor object
     * @returns {Gtk.Widget} Built-in monitor configuration widget
     * @private
     */
    _createBuiltinMonitorRow(monitor) {
        // Create a ListBox to contain the main row and brightness controls
        const listBox = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
            css_classes: ['boxed-list'],
        });

        // Main row with enable/disable toggle
        const mainRow = new Adw.ActionRow({
            title: monitor.name,
            subtitle: monitor.enabled ? 'Brightness control enabled' : 'Enable to configure brightness',
        });

        const enableSwitch = new Gtk.Switch({
            active: monitor.enabled,
            valign: Gtk.Align.CENTER,
        });

        let isInitializing = false;  // Prevent recursive calls

        enableSwitch.connect('notify::active', async () => {
            const enabled = enableSwitch.get_active();

            if (!enabled) {
                // Disabling - simple case
                monitor.enabled = false;
                mainRow.set_subtitle('Enable to configure brightness');
                this._setMonitorEnabled(monitor, enabled);

                // Rebuild to hide brightness controls
                const newRow = this._createBuiltinMonitorRow(monitor);
                this.builtinGroup.remove(listBox);
                this.builtinGroup.add(newRow);
                this.monitorRows.set(monitor.id, newRow);
                return;
            }

            // If not initialized, we need to initialize first
            if (!monitor.initialized && !isInitializing) {
                isInitializing = true;

                // Disable switch during initialization
                enableSwitch.set_sensitive(false);
                mainRow.set_subtitle('Initializing...');

                try {
                    // Initialize the monitor (this will rebuild the row when done)
                    await this._initializeMonitor(monitor, listBox);
                    // Note: Row has been rebuilt by _initializeMonitor, so don't touch old UI elements
                } catch (e) {
                    console.error(`Failed to initialize builtin monitor: ${e}`);
                    // Only revert if we're still using the same row (initialization failed early)
                    if (this.monitorRows.get(monitor.id) === listBox) {
                        enableSwitch.set_sensitive(true);
                        enableSwitch.set_active(false);
                        monitor.enabled = false;
                        mainRow.set_subtitle('Failed to initialize');
                    }
                } finally {
                    isInitializing = false;
                }
            } else if (monitor.initialized) {
                // Already initialized - toggling on
                monitor.enabled = true;
                mainRow.set_subtitle('Brightness control enabled');
                this._setMonitorEnabled(monitor, enabled);

                // Rebuild to show controls
                const newRow = this._createBuiltinMonitorRow(monitor);
                this.builtinGroup.remove(listBox);
                this.builtinGroup.add(newRow);
                this.monitorRows.set(monitor.id, newRow);
            }
        });

        mainRow.add_suffix(enableSwitch);
        mainRow.set_activatable_widget(enableSwitch);
        listBox.append(mainRow);

        // Add brightness controls if enabled and initialized
        if (monitor.enabled && monitor.initialized) {
            this._addBrightnessControlsToListBox(listBox, monitor);
        }

        return listBox;
    }

    /**
     * Create a UI row for a single monitor.
     * @param {Object} monitor - Monitor object
     * @returns {Gtk.Widget} Monitor configuration row
     * @private
     */
    _createMonitorRow(monitor) {
        if (monitor.initialized) {
            // Initialized monitor - use ExpanderRow with brightness controls
            const expanderRow = new Adw.ExpanderRow({
                title: monitor.name,
                subtitle: this._getMonitorSubtitle(monitor),
                show_enable_switch: true,
                enable_expansion: monitor.enabled,
            });

            // Connect toggle
            expanderRow.connect('notify::enable-expansion', () => {
                const enabled = expanderRow.get_enable_expansion();
                this._setMonitorEnabled(monitor, enabled);
            });

            // Add brightness controls
            this._addBrightnessControls(expanderRow, monitor);

            return expanderRow;
        } else {
            // Uninitialized monitor - use simple ActionRow with toggle
            const actionRow = new Adw.ActionRow({
                title: monitor.name,
                subtitle: this._getMonitorSubtitle(monitor),
            });

            // Add enable switch
            const enableSwitch = new Gtk.Switch({
                active: false,
                valign: Gtk.Align.CENTER,
            });

            let isInitializing = false;  // Flag to prevent recursive calls

            enableSwitch.connect('notify::active', async () => {
                const isActive = enableSwitch.get_active();
                debugLog(`[MonitorConfigDialog] Switch toggled for ${monitor.name}: active=${isActive}, isInitializing=${isInitializing}`);

                if (isActive && !isInitializing) {
                    isInitializing = true;

                    // Disable switch during initialization to prevent double-toggling
                    enableSwitch.set_sensitive(false);
                    debugLog(`[MonitorConfigDialog] Starting initialization for ${monitor.name}...`);

                    try {
                        // First time enabling - initialize
                        await this._initializeMonitor(monitor, actionRow);
                        debugLog(`[MonitorConfigDialog] Initialization successful for ${monitor.name}`);
                    } catch (e) {
                        console.error(`[MonitorConfigDialog] Initialization failed for ${monitor.name}: ${e}`);
                        debugWarn(`[MonitorConfigDialog] Error stack: ${e.stack}`);

                        // If initialization fails, revert the switch
                        enableSwitch.set_active(false);
                    } finally {
                        // Re-enable the switch
                        enableSwitch.set_sensitive(true);
                        isInitializing = false;
                        debugLog(`[MonitorConfigDialog] Initialization completed for ${monitor.name}, isInitializing=${isInitializing}`);
                    }
                } else if (!isActive) {
                    debugLog(`[MonitorConfigDialog] Switch turned off for ${monitor.name} (ignoring)`);
                }
            });

            actionRow.add_suffix(enableSwitch);
            actionRow.set_activatable_widget(enableSwitch);

            return actionRow;
        }
    }

    /**
     * Get subtitle text for a monitor.
     * @param {Object} monitor - Monitor object
     * @returns {string} Subtitle text
     * @private
     */
    _getMonitorSubtitle(monitor) {
        const parts = [];

        if (monitor.i2cBus) {
            parts.push(`I2C: /dev/i2c-${monitor.i2cBus}`);
        }

        if (monitor.serialNumber) {
            parts.push(`S/N: ${monitor.serialNumber}`);
        } else if (monitor.binarySerial) {
            parts.push(`S/N: ${monitor.binarySerial}`);
        }

        if (!monitor.initialized) {
            parts.push('Enable to read current brightness and configure');
        } else if (monitor.enabled) {
            parts.push(`Light: ${monitor.lightBrightness}% • Dark: ${monitor.darkBrightness}%`);
        } else {
            parts.push('Disabled');
        }

        return parts.join(' • ');
    }

    /**
     * Add brightness control sliders to a ListBox (for built-in monitor).
     * @param {Gtk.ListBox} listBox - Parent list box
     * @param {Object} monitor - Monitor object
     * @private
     */
    async _addBrightnessControlsToListBox(listBox, monitor) {
        // Probe once for the best backend (Mutter / SettingsDaemon d-bus / brightnessctl /
        // ddcutil). The resolved controller is then reused for both sliders below — see
        // the "ONE displayController INSTANCE PER SLIDER FOR ITS WHOLE LIFETIME" invariant
        // in brightnessSliderRow.js.
        const controller = await probeDisplayController(monitor, this.settings);

        // Light mode brightness slider
        const lightSlider = new BrightnessSliderRow(
            'Light Mode Brightness',
            `Brightness during light mode (%)`,
            null,  // No GSettings key - we handle saving via JSON
            controller,
            this.toastOverlay,
            monitor.name   // Monitor name for toast messages
        );
        this._brightnessSliders.push(lightSlider);  // Track for cleanup

        // Set value from monitor settings
        if (monitor.lightBrightness !== null) {
            lightSlider.getAdjustment().set_value(monitor.lightBrightness);
        }

        // Save changes only when not previewing
        // The BrightnessSliderRow handles preview/restore internally,
        // so we need to wait until preview is done before saving
        let lightSaveTimeoutId = null;
        lightSlider.getAdjustment().connect('value-changed', () => {
            // Clear any pending save from tracking array
            if (lightSaveTimeoutId !== null) {
                const idx = this._pendingTimeouts.indexOf(lightSaveTimeoutId);
                if (idx !== -1) this._pendingTimeouts.splice(idx, 1);
                GLib.Source.remove(lightSaveTimeoutId);
            }

            // Debounce the save to avoid conflicts with preview restore
            lightSaveTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                monitor.lightBrightness = Math.round(lightSlider.getAdjustment().get_value());
                this._saveMonitors();
                // Remove from tracking array
                const idx = this._pendingTimeouts.indexOf(lightSaveTimeoutId);
                if (idx !== -1) this._pendingTimeouts.splice(idx, 1);
                lightSaveTimeoutId = null;
                return GLib.SOURCE_REMOVE;
            });
            this._pendingTimeouts.push(lightSaveTimeoutId);  // Track for cleanup
        });

        listBox.append(lightSlider.getWidget());

        // Dark mode brightness slider
        const darkSlider = new BrightnessSliderRow(
            'Dark Mode Brightness',
            `Brightness during dark mode (%)`,
            null,  // No GSettings key - we handle saving via JSON
            controller,
            this.toastOverlay,
            monitor.name   // Monitor name for toast messages
        );
        this._brightnessSliders.push(darkSlider);  // Track for cleanup

        // Set value from monitor settings
        if (monitor.darkBrightness !== null) {
            darkSlider.getAdjustment().set_value(monitor.darkBrightness);
        }

        // Save changes only when not previewing (same debounce logic)
        let darkSaveTimeoutId = null;
        darkSlider.getAdjustment().connect('value-changed', () => {
            // Clear any pending save from tracking array
            if (darkSaveTimeoutId !== null) {
                const idx = this._pendingTimeouts.indexOf(darkSaveTimeoutId);
                if (idx !== -1) this._pendingTimeouts.splice(idx, 1);
                GLib.Source.remove(darkSaveTimeoutId);
            }

            // Debounce the save to avoid conflicts with preview restore
            darkSaveTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                monitor.darkBrightness = Math.round(darkSlider.getAdjustment().get_value());
                this._saveMonitors();
                // Remove from tracking array
                const idx = this._pendingTimeouts.indexOf(darkSaveTimeoutId);
                if (idx !== -1) this._pendingTimeouts.splice(idx, 1);
                darkSaveTimeoutId = null;
                return GLib.SOURCE_REMOVE;
            });
            this._pendingTimeouts.push(darkSaveTimeoutId);  // Track for cleanup
        });

        listBox.append(darkSlider.getWidget());
    }

    /**
     * Add brightness control sliders to a monitor row.
     * @param {Adw.ExpanderRow} expanderRow - Parent expander row
     * @param {Object} monitor - Monitor object
     * @private
     */
    async _addBrightnessControls(expanderRow, monitor) {
        // Probe once for the best backend — see invariant note in brightnessSliderRow.js.
        const controller = await probeDisplayController(monitor, this.settings);

        // Light mode brightness slider
        const lightSlider = new BrightnessSliderRow(
            'Light Mode Brightness',
            `Brightness during light mode (%)`,
            null,  // No GSettings key - we handle saving via JSON
            controller,
            this.toastOverlay,
            monitor.name   // Monitor name for toast messages
        );
        this._brightnessSliders.push(lightSlider);  // Track for cleanup

        // Set value from monitor settings
        if (monitor.lightBrightness !== null) {
            lightSlider.getAdjustment().set_value(monitor.lightBrightness);
        }

        // Save changes only when not previewing (debounced)
        let lightSaveTimeoutId = null;
        lightSlider.getAdjustment().connect('value-changed', () => {
            // Clear any pending save from tracking array
            if (lightSaveTimeoutId !== null) {
                const idx = this._pendingTimeouts.indexOf(lightSaveTimeoutId);
                if (idx !== -1) this._pendingTimeouts.splice(idx, 1);
                GLib.Source.remove(lightSaveTimeoutId);
            }
            lightSaveTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                monitor.lightBrightness = Math.round(lightSlider.getAdjustment().get_value());
                this._saveMonitors();
                // Remove from tracking array
                const idx = this._pendingTimeouts.indexOf(lightSaveTimeoutId);
                if (idx !== -1) this._pendingTimeouts.splice(idx, 1);
                lightSaveTimeoutId = null;
                return GLib.SOURCE_REMOVE;
            });
            this._pendingTimeouts.push(lightSaveTimeoutId);  // Track for cleanup
        });

        expanderRow.add_row(lightSlider.getWidget());

        // Dark mode brightness slider
        const darkSlider = new BrightnessSliderRow(
            'Dark Mode Brightness',
            `Brightness during dark mode (%)`,
            null,  // No GSettings key - we handle saving via JSON
            controller,
            this.toastOverlay,
            monitor.name   // Monitor name for toast messages
        );
        this._brightnessSliders.push(darkSlider);  // Track for cleanup

        // Set value from monitor settings
        if (monitor.darkBrightness !== null) {
            darkSlider.getAdjustment().set_value(monitor.darkBrightness);
        }

        // Save changes only when not previewing (debounced)
        let darkSaveTimeoutId = null;
        darkSlider.getAdjustment().connect('value-changed', () => {
            // Clear any pending save from tracking array
            if (darkSaveTimeoutId !== null) {
                const idx = this._pendingTimeouts.indexOf(darkSaveTimeoutId);
                if (idx !== -1) this._pendingTimeouts.splice(idx, 1);
                GLib.Source.remove(darkSaveTimeoutId);
            }
            darkSaveTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                monitor.darkBrightness = Math.round(darkSlider.getAdjustment().get_value());
                this._saveMonitors();
                // Remove from tracking array
                const idx = this._pendingTimeouts.indexOf(darkSaveTimeoutId);
                if (idx !== -1) this._pendingTimeouts.splice(idx, 1);
                darkSaveTimeoutId = null;
                return GLib.SOURCE_REMOVE;
            });
            this._pendingTimeouts.push(darkSaveTimeoutId);  // Track for cleanup
        });

        expanderRow.add_row(darkSlider.getWidget());
    }

    /**
     * Initialize a monitor by reading its current brightness.
     * @param {Object} monitor - Monitor object
     * @param {Adw.ExpanderRow} expanderRow - Parent expander row
     * @private
     */
    async _initializeMonitor(monitor, actionRow) {
        debugLog(`[MonitorConfigDialog] _initializeMonitor called for ${monitor.name}`);
        debugLog(`[MonitorConfigDialog] Monitor state: enabled=${monitor.enabled}, initialized=${monitor.initialized}`);
        debugLog(`[MonitorConfigDialog] Monitor details: id=${monitor.id}, displayNumber=${monitor.displayNumber}, i2cBus=${monitor.i2cBus}`);

        // Show progress
        const toast = new Adw.Toast({
            title: `Reading brightness from ${monitor.name}...`,
            timeout: 0,
        });
        this.toastOverlay.add_toast(toast);

        try {
            debugLog(`[MonitorConfigDialog] Probing controller for ${monitor.name}...`);
            const controller = await probeDisplayController(monitor, this.settings);

            // Read current brightness
            debugLog(`[MonitorConfigDialog] Calling getBrightness()...`);
            const currentBrightness = await controller.getBrightness();
            debugLog(`[MonitorConfigDialog] getBrightness() returned: ${currentBrightness}`);

            if (currentBrightness === null) {
                throw new Error('Failed to read brightness from monitor');
            }

            debugLog(`[MonitorConfigDialog] Current brightness for ${monitor.name}: ${currentBrightness}%`);

            // Set both light and dark to current brightness (safe default)
            monitor.lightBrightness = currentBrightness;
            monitor.darkBrightness = currentBrightness;
            monitor.initialized = true;
            monitor.enabled = true;

            debugLog(`[MonitorConfigDialog] Updated monitor state: enabled=${monitor.enabled}, initialized=${monitor.initialized}, brightness=${currentBrightness}`);

            // Update monitor in map (in case it was cleared during refresh)
            this.monitors.set(monitor.id, monitor);
            debugLog(`[MonitorConfigDialog] Monitor added to map, map size: ${this.monitors.size}`);

            // Save
            debugLog(`[MonitorConfigDialog] Saving monitors...`);
            this._saveMonitors();
            debugLog(`[MonitorConfigDialog] Monitors saved successfully`);

            // Dismiss progress toast
            toast.dismiss();

            // Show success
            const successToast = new Adw.Toast({
                title: `${monitor.name} initialized (${currentBrightness}%)`,
                timeout: 3,
            });
            this.toastOverlay.add_toast(successToast);

            // Rebuild the row with controls
            debugLog(`[MonitorConfigDialog] Rebuilding row with controls...`);

            // Determine which group and creation method to use based on monitor type
            const isBuiltin = monitor.type === 'brightnessctl';
            const group = isBuiltin ? this.builtinGroup : this.monitorsGroup;

            group.remove(actionRow);
            const newRow = isBuiltin ? this._createBuiltinMonitorRow(monitor) : this._createMonitorRow(monitor);
            group.add(newRow);
            this.monitorRows.set(monitor.id, newRow);

            // Expand the row to show controls (only for external monitors with ExpanderRow)
            if (!isBuiltin && newRow.set_expanded) {
                newRow.set_expanded(true);
            }
            debugLog(`[MonitorConfigDialog] Row rebuilt successfully`);

        } catch (e) {
            console.error(`[MonitorConfigDialog] EXCEPTION in _initializeMonitor for ${monitor.name}: ${e}`);
            debugWarn(`[MonitorConfigDialog] Exception message: ${e.message}`);
            debugWarn(`[MonitorConfigDialog] Exception stack: ${e.stack}`);

            toast.dismiss();

            const errorToast = new Adw.Toast({
                title: `Failed to initialize ${monitor.name}: ${e.message}`,
                timeout: 5,
            });
            this.toastOverlay.add_toast(errorToast);

            // Re-throw so the caller knows initialization failed
            throw e;
        }
    }

    /**
     * Enable or disable a monitor.
     * @param {Object} monitor - Monitor object
     * @param {boolean} enabled - Whether to enable the monitor
     * @private
     */
    _setMonitorEnabled(monitor, enabled) {
        monitor.enabled = enabled;
        this._saveMonitors();

        debugLog(`MonitorConfigDialog: ${monitor.name} ${enabled ? 'enabled' : 'disabled'}`);

        // Update subtitle
        const row = this.monitorRows.get(monitor.id);
        if (row) {
            row.set_subtitle(this._getMonitorSubtitle(monitor));
        }
    }

    /**
     * Save all monitors to settings.
     * @private
     */
    _saveMonitors() {
        const allMonitors = Array.from(this.monitors.values());
        allMonitors.forEach(m => {
            debugLog(`MonitorConfigDialog: Saving monitor: id=${m.id}, enabled=${m.enabled}, initialized=${m.initialized}, lightBrightness=${m.lightBrightness}, darkBrightness=${m.darkBrightness}`);
        });
        this.displayManager.saveMonitors(allMonitors);
    }

    /**
     * Close the dialog.
     */
    close() {
        if (this.dialog) {
            this.dialog.close();
        }
    }
}
