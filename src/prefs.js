import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {
    BRIGHTNESS_UPDATE_INTERVAL_MS,
    DEBUG_TIME_UPDATE_INTERVAL_SECONDS,
    DEBUG_INFO_REFRESH_INTERVAL_SECONDS,
    FORCE_REFRESH_DEBOUNCE_MS,
    MS_PER_SECOND,
    BRIGHTNESS_TRANSITION_DURATIONS
} from './constants.js';

export default class ThemeSwitcherPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        // Get the settings schema for this extension
        this.settings = this.getSettings();

        // Create a preferences page and group
        const page = new Adw.PreferencesPage({
            title: 'Settings',
            icon_name: 'preferences-system-symbolic',
        });

        // --- Auto-Detect Location Toggle ---
        const locationGroup = new Adw.PreferencesGroup({ title: 'Location Detection' });
        page.add(locationGroup);

        const autoDetectRow = new Adw.ActionRow({
            title: 'Auto-detect Location',
            subtitle: 'Automatically detect your location using IP address',
        });
        const autoDetectToggle = new Gtk.Switch({
            active: this.settings.get_boolean('auto-detect-location'),
            valign: Gtk.Align.CENTER,
        });
        autoDetectRow.add_suffix(autoDetectToggle);
        autoDetectRow.activatable_widget = autoDetectToggle;
        locationGroup.add(autoDetectRow);

        // Disclaimer banner for auto-detect
        const disclaimerExpander = new Adw.ExpanderRow({
            title: 'Important: Location Accuracy',
            subtitle: 'Click to learn about auto-detection limitations',
            show_enable_switch: false,
        });

        const disclaimerContent = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            margin_top: 6,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12,
        });

        const warningLabel = new Gtk.Label({
            label: '⚠️ Location is approximate based on IP address',
            xalign: 0,
            wrap: true,
        });
        warningLabel.add_css_class('warning');

        const detailLabel = new Gtk.Label({
            label: '• Timings may be inaccurate if using a VPN or proxy\n• IP-based detection can be off by several kilometers\n• For precise results, turn off Auto-detect Location to enter coordinates manually',
            xalign: 0,
            wrap: true,
        });
        detailLabel.add_css_class('dim-label');

        disclaimerContent.append(warningLabel);
        disclaimerContent.append(detailLabel);

        disclaimerExpander.add_row(new Adw.PreferencesRow({
            child: disclaimerContent,
        }));

        locationGroup.add(disclaimerExpander);

        // Manual coordinates section (shown when auto-detect is OFF)
        const manualCoordinatesToggleRow = new Adw.ActionRow({
            title: 'Use Manual Coordinates',
            subtitle: 'Enter your exact latitude and longitude for precise sunrise/sunset times',
        });
        const manualCoordinatesToggle = new Gtk.Switch({
            active: this.settings.get_boolean('use-manual-coordinates'),
            valign: Gtk.Align.CENTER,
        });
        manualCoordinatesToggleRow.add_suffix(manualCoordinatesToggle);
        manualCoordinatesToggleRow.activatable_widget = manualCoordinatesToggle;
        locationGroup.add(manualCoordinatesToggleRow);

        const latitudeRow = new Adw.ActionRow({
            title: 'Latitude',
            subtitle: 'Example: 37.7749 (north is positive, south is negative)',
        });
        const latitudeEntry = new Gtk.Entry({
            text: this.settings.get_string('manual-latitude'),
            placeholder_text: '0.0000',
            valign: Gtk.Align.CENTER,
        });
        latitudeRow.add_suffix(latitudeEntry);
        locationGroup.add(latitudeRow);

        const longitudeRow = new Adw.ActionRow({
            title: 'Longitude',
            subtitle: 'Example: -122.4194 (east is positive, west is negative)',
        });
        const longitudeEntry = new Gtk.Entry({
            text: this.settings.get_string('manual-longitude'),
            placeholder_text: '0.0000',
            valign: Gtk.Align.CENTER,
        });
        longitudeRow.add_suffix(longitudeEntry);
        locationGroup.add(longitudeRow);

        const group = new Adw.PreferencesGroup({ title: 'Theme Settings' });
        page.add(group);

        // --- Light Theme Dropdown ---
        const lightThemeRow = new Adw.ComboRow({
            title: 'Light Theme',
            subtitle: 'Theme to use during the day',
        });
        const lightThemeModel = new Gtk.StringList();
        // A simple way to get themes. A more robust method would be needed for production.
        const themes = Gio.File.new_for_path('/usr/share/themes').enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = themes.next_file(null))) {
            lightThemeModel.append(info.get_name());
        }
        lightThemeRow.model = lightThemeModel;
        group.add(lightThemeRow);

        // --- Dark Theme Dropdown ---
        const darkThemeRow = new Adw.ComboRow({
            title: 'Dark Theme',
            subtitle: 'Theme to use at night',
        });
        const darkThemeModel = new Gtk.StringList();
        const themes2 = Gio.File.new_for_path('/usr/share/themes').enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        while ((info = themes2.next_file(null))) {
            darkThemeModel.append(info.get_name());
        }
        darkThemeRow.model = darkThemeModel;
        group.add(darkThemeRow);

        // --- True Light Mode Toggle ---
        const trueLightModeRow = new Adw.ActionRow({
            title: 'True Light Mode',
            subtitle: 'Also change the Shell/top bar color when switching themes (may not work with Ubuntu)',
        });
        const trueLightModeToggle = new Gtk.Switch({
            active: this.settings.get_boolean('true-light-mode'),
            valign: Gtk.Align.CENTER,
        });
        trueLightModeRow.add_suffix(trueLightModeToggle);
        trueLightModeRow.activatable_widget = trueLightModeToggle;
        group.add(trueLightModeRow);

        // --- Night Light Options ---
        const nightLightGroup = new Adw.PreferencesGroup({ title: 'Night Light Control' });
        page.add(nightLightGroup);

        const nightLightModeRow = new Adw.ComboRow({
            title: 'Night Light Mode',
        });
        const nightLightModel = new Gtk.StringList();
        nightLightModel.append('Disabled');
        nightLightModel.append('Sync with Theme');
        nightLightModel.append('Custom Schedule');
        nightLightModeRow.model = nightLightModel;
        nightLightGroup.add(nightLightModeRow);

        const nightLightMap = { 0: 'disabled', 1: 'sync-with-theme', 2: 'custom-schedule' };
        const savedNightLightMode = this.settings.get_string('night-light-mode');
        const nightLightIndex = Object.keys(nightLightMap).find(key => nightLightMap[key] === savedNightLightMode) || 0;
        nightLightModeRow.selected = nightLightIndex;

        // --- Night Light Custom Schedule Times ---
        const nightLightStartRow = new Adw.ActionRow({
            title: 'Night Light Start Time (24-hour)',
        });
        const nightLightStartEntry = new Gtk.Entry({
            text: this.settings.get_string('night-light-start-time'),
            valign: Gtk.Align.CENTER,
        });
        nightLightStartRow.add_suffix(nightLightStartEntry);
        nightLightGroup.add(nightLightStartRow);

        const nightLightEndRow = new Adw.ActionRow({
            title: 'Night Light End Time (24-hour)',
        });
        const nightLightEndEntry = new Gtk.Entry({
            text: this.settings.get_string('night-light-end-time'),
            valign: Gtk.Align.CENTER,
        });
        nightLightEndRow.add_suffix(nightLightEndEntry);
        nightLightGroup.add(nightLightEndRow);

        // Show/hide Night Light schedule times based on mode
        nightLightStartRow.visible = nightLightModeRow.selected === 2;
        nightLightEndRow.visible = nightLightModeRow.selected === 2;
        nightLightModeRow.connect('notify::selected', () => {
            nightLightStartRow.visible = nightLightModeRow.selected === 2;
            nightLightEndRow.visible = nightLightModeRow.selected === 2;
        });

        // --- Notifications Toggle ---
        const notificationsRow = new Adw.ActionRow({
            title: 'Show Notifications',
            subtitle: 'Display a notification when theme switches automatically',
        });
        const notificationsToggle = new Gtk.Switch({
            active: this.settings.get_boolean('show-notifications'),
            valign: Gtk.Align.CENTER,
        });
        notificationsRow.add_suffix(notificationsToggle);
        notificationsRow.activatable_widget = notificationsToggle;
        group.add(notificationsRow);

        // --- Light Mode Trigger Settings ---
        const lightTriggerGroup = new Adw.PreferencesGroup({ title: 'Light Mode Trigger' });
        page.add(lightTriggerGroup);

        const lightTriggerRow = new Adw.ComboRow({
            title: 'Switch to Light Mode at...',
        });
        const lightTriggerModel = new Gtk.StringList();
        lightTriggerModel.append('First Light');
        lightTriggerModel.append('Dawn');
        lightTriggerModel.append('Sunrise');
        lightTriggerModel.append('Solar Noon');
        lightTriggerModel.append('Specific Time');
        lightTriggerRow.model = lightTriggerModel;
        lightTriggerGroup.add(lightTriggerRow);

        const lightTriggerMap = { 0: 'first-light', 1: 'dawn', 2: 'sunrise', 3: 'solar-noon', 4: 'custom' };
        const savedLightTrigger = this.settings.get_string('light-mode-trigger');
        const lightTriggerIndex = Object.keys(lightTriggerMap).find(key => lightTriggerMap[key] === savedLightTrigger) || 2;
        lightTriggerRow.selected = lightTriggerIndex;

        // --- Specific Light Time Entry ---
        const customLightTimeRow = new Adw.ActionRow({
            title: 'Specific Light Time (24-hour)',
        });
        const customLightTimeEntry = new Gtk.Entry({
            text: this.settings.get_string('custom-light-time'),
            valign: Gtk.Align.CENTER,
        });
        customLightTimeRow.add_suffix(customLightTimeEntry);
        lightTriggerGroup.add(customLightTimeRow);

        // Function to update visibility based on auto-detect and manual coordinates settings
        const updateLightTriggerVisibility = () => {
            const autoDetectEnabled = this.settings.get_boolean('auto-detect-location');
            const useManualCoords = this.settings.get_boolean('use-manual-coordinates');

            // Show triggers if auto-detect OR manual coordinates is enabled
            const showTriggers = autoDetectEnabled || useManualCoords;

            if (showTriggers) {
                // Show dropdown with all options
                lightTriggerRow.visible = true;
                // Show time entry only if 'Specific Time' is selected
                customLightTimeRow.visible = lightTriggerRow.selected === 3;
            } else {
                // Hide dropdown, only show time entry
                lightTriggerRow.visible = false;
                customLightTimeRow.visible = true;
            }
        };

        // Initial visibility
        updateLightTriggerVisibility();

        // Update visibility when settings change
        this.settings.connect('changed::auto-detect-location', updateLightTriggerVisibility);
        this.settings.connect('changed::use-manual-coordinates', updateLightTriggerVisibility);

        // Show/hide specific light time row based on trigger selection (when auto-detect is on)
        lightTriggerRow.connect('notify::selected', () => {
            if (this.settings.get_boolean('auto-detect-location')) {
                customLightTimeRow.visible = lightTriggerRow.selected === 3;
            }
        });

        // --- Dark Mode Trigger Settings ---
        const darkTriggerGroup = new Adw.PreferencesGroup({ title: 'Dark Mode Trigger' });
        page.add(darkTriggerGroup);

        const darkTriggerRow = new Adw.ComboRow({
            title: 'Switch to Dark Mode at...',
        });
        const darkTriggerModel = new Gtk.StringList();
        darkTriggerModel.append('Solar Noon');
        darkTriggerModel.append('Golden Hour');
        darkTriggerModel.append('Sunset');
        darkTriggerModel.append('Dusk');
        darkTriggerModel.append('Last Light');
        darkTriggerModel.append('Specific Time');
        darkTriggerRow.model = darkTriggerModel;
        darkTriggerGroup.add(darkTriggerRow);

        const darkTriggerMap = { 0: 'solar-noon', 1: 'golden-hour', 2: 'sunset', 3: 'dusk', 4: 'last-light', 5: 'custom' };
        const savedDarkTrigger = this.settings.get_string('dark-mode-trigger');
        const darkTriggerIndex = Object.keys(darkTriggerMap).find(key => darkTriggerMap[key] === savedDarkTrigger) || 0;
        darkTriggerRow.selected = darkTriggerIndex;

        // --- Specific Dark Time Entry ---
        const customDarkTimeRow = new Adw.ActionRow({
            title: 'Specific Dark Time (24-hour)',
        });
        const customDarkTimeEntry = new Gtk.Entry({
            text: this.settings.get_string('custom-dark-time'),
            valign: Gtk.Align.CENTER,
        });
        customDarkTimeRow.add_suffix(customDarkTimeEntry);
        darkTriggerGroup.add(customDarkTimeRow);

        // Function to update visibility based on auto-detect and manual coordinates settings
        const updateDarkTriggerVisibility = () => {
            const autoDetectEnabled = this.settings.get_boolean('auto-detect-location');
            const useManualCoords = this.settings.get_boolean('use-manual-coordinates');

            // Show triggers if auto-detect OR manual coordinates is enabled
            const showTriggers = autoDetectEnabled || useManualCoords;

            if (showTriggers) {
                // Show dropdown with all options
                darkTriggerRow.visible = true;
                // Show time entry only if 'Specific Time' is selected
                customDarkTimeRow.visible = darkTriggerRow.selected === 3;
            } else {
                // Hide dropdown, only show time entry
                darkTriggerRow.visible = false;
                customDarkTimeRow.visible = true;
            }
        };

        // Initial visibility
        updateDarkTriggerVisibility();

        // Update visibility when settings change
        this.settings.connect('changed::auto-detect-location', updateDarkTriggerVisibility);
        this.settings.connect('changed::use-manual-coordinates', updateDarkTriggerVisibility);

        // Show/hide specific dark time row based on trigger selection (when auto-detect is on)
        darkTriggerRow.connect('notify::selected', () => {
            if (this.settings.get_boolean('auto-detect-location')) {
                customDarkTimeRow.visible = darkTriggerRow.selected === 3;
            }
        });


        // --- Brightness Control ---
        const brightnessGroup = new Adw.PreferencesGroup({ title: 'Brightness Control' });
        page.add(brightnessGroup);

        // Check if brightnessctl is available
        const hasBrightnessctl = this._checkBrightnessctl();

        const controlBrightnessRow = new Adw.ActionRow({
            title: 'Control Brightness',
            subtitle: hasBrightnessctl ?
                'Gradually adjust screen brightness throughout the day' :
                '⚠️ Package not found - see installation instructions below',
        });
        const controlBrightnessToggle = new Gtk.Switch({
            active: false, // Always start disabled - will be set by binding if brightnessctl is available
            sensitive: hasBrightnessctl,
            valign: Gtk.Align.CENTER,
        });
        controlBrightnessRow.add_suffix(controlBrightnessToggle);
        // Only make row activatable if brightnessctl is available
        if (hasBrightnessctl) {
            controlBrightnessRow.activatable_widget = controlBrightnessToggle;
        }
        brightnessGroup.add(controlBrightnessRow);

        // If brightnessctl is not available, show installation instructions
        if (!hasBrightnessctl) {
            const installExpander = new Adw.ExpanderRow({
                title: 'How to Install brightnessctl',
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

            const instructionLabel = new Gtk.Label({
                label: 'Step 1: Open a terminal and install brightnessctl',
                xalign: 0,
                wrap: true,
            });
            instructionLabel.add_css_class('heading');

            // Command 1: Install brightnessctl
            const commandBox1 = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                spacing: 6,
            });

            const commandEntry1 = new Gtk.Entry({
                text: 'sudo apt install brightnessctl',
                editable: false,
                hexpand: true,
            });

            const copyButton1 = new Gtk.Button({
                label: 'Copy',
                valign: Gtk.Align.CENTER,
            });
            copyButton1.connect('clicked', () => {
                const clipboard = window.get_display().get_clipboard();
                clipboard.set('sudo apt install brightnessctl');
            });

            commandBox1.append(commandEntry1);
            commandBox1.append(copyButton1);

            const step2Label = new Gtk.Label({
                label: 'Step 2: Add your user to the video group for permissions',
                xalign: 0,
                wrap: true,
                margin_top: 12,
            });
            step2Label.add_css_class('heading');

            // Command 2: Add user to video group
            const commandBox2 = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                spacing: 6,
                margin_top: 6,
            });

            const commandEntry2 = new Gtk.Entry({
                text: 'sudo usermod -a -G video $USER',
                editable: false,
                hexpand: true,
            });

            const copyButton2 = new Gtk.Button({
                label: 'Copy',
                valign: Gtk.Align.CENTER,
            });
            copyButton2.connect('clicked', () => {
                const clipboard = window.get_display().get_clipboard();
                clipboard.set('sudo usermod -a -G video $USER');
            });

            commandBox2.append(commandEntry2);
            commandBox2.append(copyButton2);

            const step3Label = new Gtk.Label({
                label: 'Step 3: Log out and log back in',
                xalign: 0,
                wrap: true,
                margin_top: 12,
            });
            step3Label.add_css_class('heading');

            const logoutNote = new Gtk.Label({
                label: 'IMPORTANT: You must log out and log back in (or reboot) for the group membership to take effect. The brightness controls will not work until you do this.',
                xalign: 0,
                wrap: true,
                margin_top: 6,
            });
            logoutNote.add_css_class('dim-label');

            const distroNote = new Gtk.Label({
                label: 'Note: These commands work on Ubuntu/Debian. For other distributions, use your package manager.',
                xalign: 0,
                wrap: true,
                margin_top: 12,
            });
            distroNote.add_css_class('dim-label');

            installBox.append(instructionLabel);
            installBox.append(commandBox1);
            installBox.append(step2Label);
            installBox.append(commandBox2);
            installBox.append(step3Label);
            installBox.append(logoutNote);
            installBox.append(distroNote);

            installExpander.add_row(new Adw.PreferencesRow({
                child: installBox,
            }));

            brightnessGroup.add(installExpander);
        }

        // Brightness sliders and gradual transition controls
        // Grouped: Light Mode Brightness + Gradual Brightening
        const lightBrightnessRow = new Adw.ActionRow({
            title: 'Light Mode Brightness',
            subtitle: 'Screen brightness during light mode (%)',
        });
        const lightBrightnessAdjustment = new Gtk.Adjustment({
            lower: 1,
            upper: 100,
            step_increment: 1,
            page_increment: 10,
            value: this.settings.get_int('light-brightness'),
        });
        const lightBrightnessScale = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL,
            draw_value: true,
            value_pos: Gtk.PositionType.RIGHT,
            digits: 0,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            adjustment: lightBrightnessAdjustment,
        });
        lightBrightnessRow.add_suffix(lightBrightnessScale);
        brightnessGroup.add(lightBrightnessRow);

        // Gradual Brightening (combined toggle + duration)
        const increaseDurationRow = new Adw.ComboRow({
            title: 'Gradual brightening',
            subtitle: 'Gradually increase brightness before light mode',
        });
        const increaseDurationModel = new Gtk.StringList();
        BRIGHTNESS_TRANSITION_DURATIONS.forEach(duration => {
            increaseDurationModel.append(duration.label);
        });
        increaseDurationRow.model = increaseDurationModel;
        brightnessGroup.add(increaseDurationRow);

        // Find and set the current selection (Off if disabled, otherwise the duration)
        const savedIncreaseEnabled = this.settings.get_boolean('gradual-brightness-increase-enabled');
        const savedIncreaseDuration = this.settings.get_int('gradual-brightness-increase-duration');
        if (!savedIncreaseEnabled) {
            increaseDurationRow.selected = 0; // "Off"
        } else {
            const increaseIndex = BRIGHTNESS_TRANSITION_DURATIONS.findIndex(d => d.value === savedIncreaseDuration);
            increaseDurationRow.selected = increaseIndex >= 0 ? increaseIndex : 5; // Default to 2 hours (index 5)
        }

        // Grouped: Dark Mode Brightness + Gradual Dimming
        const darkBrightnessRow = new Adw.ActionRow({
            title: 'Dark Mode Brightness',
            subtitle: 'Screen brightness during dark mode (%)',
        });
        const darkBrightnessAdjustment = new Gtk.Adjustment({
            lower: 1,
            upper: 100,
            step_increment: 1,
            page_increment: 10,
            value: this.settings.get_int('dark-brightness'),
        });
        const darkBrightnessScale = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL,
            draw_value: true,
            value_pos: Gtk.PositionType.RIGHT,
            digits: 0,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            adjustment: darkBrightnessAdjustment,
        });
        darkBrightnessRow.add_suffix(darkBrightnessScale);
        brightnessGroup.add(darkBrightnessRow);

        // Gradual Dimming (combined toggle + duration)
        const decreaseDurationRow = new Adw.ComboRow({
            title: 'Gradual dimming',
            subtitle: 'Gradually decrease brightness before dark mode',
        });
        const decreaseDurationModel = new Gtk.StringList();
        BRIGHTNESS_TRANSITION_DURATIONS.forEach(duration => {
            decreaseDurationModel.append(duration.label);
        });
        decreaseDurationRow.model = decreaseDurationModel;
        brightnessGroup.add(decreaseDurationRow);

        // Find and set the current selection (Off if disabled, otherwise the duration)
        const savedDecreaseEnabled = this.settings.get_boolean('gradual-brightness-decrease-enabled');
        const savedDecreaseDuration = this.settings.get_int('gradual-brightness-decrease-duration');
        if (!savedDecreaseEnabled) {
            decreaseDurationRow.selected = 0; // "Off"
        } else {
            const decreaseIndex = BRIGHTNESS_TRANSITION_DURATIONS.findIndex(d => d.value === savedDecreaseDuration);
            decreaseDurationRow.selected = decreaseIndex >= 0 ? decreaseIndex : 5; // Default to 2 hours (index 5)
        }

        // Initialize brightness values from current system brightness
        if (hasBrightnessctl) {
            this._initializeBrightnessValues(lightBrightnessScale, darkBrightnessScale);
        }

        // Connect settings changes
        // When user selects "Off" (index 0), disable the feature; otherwise enable and set duration
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

        // Show/hide brightness sliders and gradual transition controls based on control-brightness toggle
        const updateBrightnessVisibility = () => {
            const enabled = hasBrightnessctl && this.settings.get_boolean('control-brightness');
            lightBrightnessRow.visible = enabled;
            increaseDurationRow.visible = enabled;
            darkBrightnessRow.visible = enabled;
            decreaseDurationRow.visible = enabled;
        };
        updateBrightnessVisibility();
        this.settings.connect('changed::control-brightness', updateBrightnessVisibility);

        // Warning label for time conflicts
        const brightnessWarningRow = new Adw.ActionRow({
            title: '⚠️ Warning',
            subtitle: '',
        });
        brightnessWarningRow.add_css_class('warning');
        brightnessGroup.add(brightnessWarningRow);
        brightnessWarningRow.visible = false;

        // Function to validate and show warnings for brightness transition conflicts
        const validateBrightnessTransitions = () => {
            if (!hasBrightnessctl || !this.settings.get_boolean('control-brightness')) {
                brightnessWarningRow.visible = false;
                return;
            }

            const autoDetect = this.settings.get_boolean('auto-detect-location');
            const lightTrigger = this.settings.get_string('light-mode-trigger');
            const darkTrigger = this.settings.get_string('dark-mode-trigger');

            // Can only validate custom times, not API-based triggers
            if (lightTrigger !== 'custom' || darkTrigger !== 'custom') {
                brightnessWarningRow.visible = false;
                return;
            }

            const customLightTime = this.settings.get_string('custom-light-time');
            const customDarkTime = this.settings.get_string('custom-dark-time');

            // Parse times
            const parseTime = (timeStr) => {
                const [hours, minutes] = timeStr.split(':').map(Number);
                const date = new Date();
                date.setHours(hours, minutes, 0, 0);
                return date;
            };

            try {
                const lightTime = parseTime(customLightTime);
                const darkTime = parseTime(customDarkTime);

                // Calculate time between light and dark mode
                let timeBetween;
                if (darkTime > lightTime) {
                    timeBetween = darkTime.getTime() - lightTime.getTime();
                } else {
                    // Dark time is before light time (crosses midnight)
                    timeBetween = (24 * 60 * 60 * 1000) - (lightTime.getTime() - darkTime.getTime());
                }

                // Check if transitions are enabled (not "Off")
                const decreaseEnabled = decreaseDurationRow.selected > 0;
                const increaseEnabled = increaseDurationRow.selected > 0;
                const decreaseDuration = BRIGHTNESS_TRANSITION_DURATIONS[decreaseDurationRow.selected]?.value || 0;
                const increaseDuration = BRIGHTNESS_TRANSITION_DURATIONS[increaseDurationRow.selected]?.value || 0;

                const timeBetweenSeconds = timeBetween / 1000;

                // Check if transitions would overlap
                if (decreaseEnabled && decreaseDuration >= timeBetweenSeconds) {
                    brightnessWarningRow.subtitle = `Dimming duration (${decreaseDuration / 3600}h) is longer than the time between light and dark mode (${Math.round(timeBetweenSeconds / 3600 * 10) / 10}h). Gradual dimming will be disabled until this is fixed.`;
                    brightnessWarningRow.visible = true;
                    return;
                }

                if (increaseEnabled && increaseDuration >= timeBetweenSeconds) {
                    brightnessWarningRow.subtitle = `Brightening duration (${increaseDuration / 3600}h) is longer than the time between light and dark mode (${Math.round(timeBetweenSeconds / 3600 * 10) / 10}h). Gradual brightening will be disabled until this is fixed.`;
                    brightnessWarningRow.visible = true;
                    return;
                }

                brightnessWarningRow.visible = false;
            } catch (e) {
                console.error('Error validating brightness transitions:', e);
                brightnessWarningRow.visible = false;
            }
        };

        // Run validation when settings change
        this.settings.connect('changed::control-brightness', validateBrightnessTransitions);
        this.settings.connect('changed::custom-light-time', validateBrightnessTransitions);
        this.settings.connect('changed::custom-dark-time', validateBrightnessTransitions);
        this.settings.connect('changed::light-mode-trigger', validateBrightnessTransitions);
        this.settings.connect('changed::dark-mode-trigger', validateBrightnessTransitions);
        decreaseDurationRow.connect('notify::selected', validateBrightnessTransitions);
        increaseDurationRow.connect('notify::selected', validateBrightnessTransitions);

        // Initial validation
        validateBrightnessTransitions();


        // --- Bind settings to UI widgets ---
        // Load saved theme selections
        const savedLightTheme = this.settings.get_string('light-theme');
        const savedDarkTheme = this.settings.get_string('dark-theme');

        // Find and set the selected index for light theme
        for (let i = 0; i < lightThemeModel.get_n_items(); i++) {
            if (lightThemeModel.get_string(i) === savedLightTheme) {
                lightThemeRow.selected = i;
                break;
            }
        }

        // Find and set the selected index for dark theme
        for (let i = 0; i < darkThemeModel.get_n_items(); i++) {
            if (darkThemeModel.get_string(i) === savedDarkTheme) {
                darkThemeRow.selected = i;
                break;
            }
        }

        // Connect to save changes
        lightThemeRow.connect('notify::selected', () => {
            const selected = lightThemeRow.selected_item;
            if (selected) {
                this.settings.set_string('light-theme', selected.string);
            }
        });

        darkThemeRow.connect('notify::selected', () => {
            const selected = darkThemeRow.selected_item;
            if (selected) {
                this.settings.set_string('dark-theme', selected.string);
            }
        });

        this.settings.bind('auto-detect-location', autoDetectToggle, 'active', Gio.SettingsBindFlags.DEFAULT);
        this.settings.bind('use-manual-coordinates', manualCoordinatesToggle, 'active', Gio.SettingsBindFlags.DEFAULT);
        this.settings.bind('manual-latitude', latitudeEntry, 'text', Gio.SettingsBindFlags.DEFAULT);
        this.settings.bind('manual-longitude', longitudeEntry, 'text', Gio.SettingsBindFlags.DEFAULT);
        this.settings.bind('true-light-mode', trueLightModeToggle, 'active', Gio.SettingsBindFlags.DEFAULT);
        this.settings.bind('show-notifications', notificationsToggle, 'active', Gio.SettingsBindFlags.DEFAULT);
        this.settings.bind('custom-light-time', customLightTimeEntry, 'text', Gio.SettingsBindFlags.DEFAULT);
        this.settings.bind('custom-dark-time', customDarkTimeEntry, 'text', Gio.SettingsBindFlags.DEFAULT);
        this.settings.bind('night-light-start-time', nightLightStartEntry, 'text', Gio.SettingsBindFlags.DEFAULT);
        this.settings.bind('night-light-end-time', nightLightEndEntry, 'text', Gio.SettingsBindFlags.DEFAULT);

        // Visibility logic for location-related UI elements
        const updateLocationUIVisibility = () => {
            const autoDetect = this.settings.get_boolean('auto-detect-location');
            const useManualCoords = this.settings.get_boolean('use-manual-coordinates');

            // Disclaimer only shows when auto-detect is ON
            disclaimerExpander.visible = autoDetect;

            // Manual coordinates toggle only shows when auto-detect is OFF
            manualCoordinatesToggleRow.visible = !autoDetect;

            // Coordinate fields only show when auto-detect is OFF AND manual coordinates is ON
            latitudeRow.visible = !autoDetect && useManualCoords;
            longitudeRow.visible = !autoDetect && useManualCoords;
        };

        // Initial visibility
        updateLocationUIVisibility();

        // Update visibility when settings change
        this.settings.connect('changed::auto-detect-location', updateLocationUIVisibility);
        this.settings.connect('changed::use-manual-coordinates', updateLocationUIVisibility);

        lightTriggerRow.connect('notify::selected', () => {
            this.settings.set_string('light-mode-trigger', lightTriggerMap[lightTriggerRow.selected]);
        });

        darkTriggerRow.connect('notify::selected', () => {
            this.settings.set_string('dark-mode-trigger', darkTriggerMap[darkTriggerRow.selected]);
        });

        nightLightModeRow.connect('notify::selected', () => {
            this.settings.set_string('night-light-mode', nightLightMap[nightLightModeRow.selected]);
        });

        // Brightness control bindings
        if (hasBrightnessctl) {
            // Only bind if brightnessctl is available
            this.settings.bind('control-brightness', controlBrightnessToggle, 'active', Gio.SettingsBindFlags.DEFAULT);
        } else {
            // If not available, ensure setting is false and toggle stays disabled
            this.settings.set_boolean('control-brightness', false);
            controlBrightnessToggle.active = false;
        }

        // Real-time brightness preview on slider drag
        if (hasBrightnessctl) {
            let originalBrightness = null;
            let isLightGrabbed = false;
            let isDarkGrabbed = false;
            let currentPreviewToast = null;

            // Helper to get current system brightness
            const getCurrentBrightness = () => {
                try {
                    const [success, stdout] = GLib.spawn_command_line_sync('brightnessctl get');
                    if (success) {
                        return parseInt(new TextDecoder().decode(stdout).trim());
                    }
                } catch (e) {
                    console.error(`Failed to get brightness: ${e}`);
                }
                return null;
            };

            // Helper to set brightness
            const setBrightness = (value) => {
                try {
                    GLib.spawn_command_line_async(`brightnessctl set ${value}`);
                } catch (e) {
                    console.error(`Failed to set brightness: ${e}`);
                }
            };

            // Light brightness slider with gesture for press/release detection
            // Note: GtkScale doesn't emit released when dragging, so we attach to the row with capture phase
            const lightGesture = new Gtk.GestureClick();
            lightGesture.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
            lightBrightnessRow.add_controller(lightGesture);

            lightGesture.connect('pressed', () => {
                isLightGrabbed = true;
                originalBrightness = getCurrentBrightness();

                // Show preview toast
                const toast = new Adw.Toast({
                    title: 'Previewing brightness...',
                    timeout: 0,  // Don't auto-dismiss
                });
                currentPreviewToast = toast;
                window.add_toast(toast);
            });

            lightGesture.connect('released', () => {
                isLightGrabbed = false;

                // Save the final value
                const finalValue = Math.round(lightBrightnessAdjustment.get_value());
                this.settings.set_int('light-brightness', finalValue);

                // Dismiss preview toast
                if (currentPreviewToast) {
                    currentPreviewToast.dismiss();
                    currentPreviewToast = null;
                }

                // Restore original brightness
                if (originalBrightness !== null) {
                    setBrightness(originalBrightness);
                    originalBrightness = null;

                    // Show "restored" toast
                    const restoredToast = new Adw.Toast({
                        title: 'Brightness restored',
                        timeout: 2,
                    });
                    window.add_toast(restoredToast);
                }
            });

            // Update brightness in real-time while grabbed
            lightBrightnessAdjustment.connect('value-changed', () => {
                if (isLightGrabbed) {
                    const percent = Math.round(lightBrightnessAdjustment.get_value());
                    setBrightness(`${percent}%`);
                }
            });

            // Dark brightness slider with gesture for press/release detection
            // Note: GtkScale doesn't emit released when dragging, so we attach to the row with capture phase
            const darkGesture = new Gtk.GestureClick();
            darkGesture.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
            darkBrightnessRow.add_controller(darkGesture);

            darkGesture.connect('pressed', () => {
                isDarkGrabbed = true;
                originalBrightness = getCurrentBrightness();

                // Show preview toast
                const toast = new Adw.Toast({
                    title: 'Previewing brightness...',
                    timeout: 0,  // Don't auto-dismiss
                });
                currentPreviewToast = toast;
                window.add_toast(toast);
            });

            darkGesture.connect('released', () => {
                isDarkGrabbed = false;

                // Save the final value
                const finalValue = Math.round(darkBrightnessAdjustment.get_value());
                this.settings.set_int('dark-brightness', finalValue);

                // Dismiss preview toast
                if (currentPreviewToast) {
                    currentPreviewToast.dismiss();
                    currentPreviewToast = null;
                }

                // Restore original brightness
                if (originalBrightness !== null) {
                    setBrightness(originalBrightness);
                    originalBrightness = null;

                    // Show "restored" toast
                    const restoredToast = new Adw.Toast({
                        title: 'Brightness restored',
                        timeout: 2,
                    });
                    window.add_toast(restoredToast);
                }
            });

            // Update brightness in real-time while grabbed
            darkBrightnessAdjustment.connect('value-changed', () => {
                if (isDarkGrabbed) {
                    const percent = Math.round(darkBrightnessAdjustment.get_value());
                    setBrightness(`${percent}%`);
                }
            });
        }

        // Add the settings page to the window
        window.add(page);

        // --- Debug Panel Page ---
        const debugPage = new Adw.PreferencesPage({
            title: 'Debug',
            icon_name: 'dialog-information-symbolic',
        });

        const debugGroup = new Adw.PreferencesGroup({ title: 'Debug Information' });
        debugPage.add(debugGroup);

        // Info display rows
        const currentModeRow = new Adw.ActionRow({ title: 'Current Mode' });
        const currentModeLabel = new Gtk.Label({ label: 'N/A' });
        currentModeRow.add_suffix(currentModeLabel);
        debugGroup.add(currentModeRow);

        const currentTimeRow = new Adw.ActionRow({ title: 'Current Time' });
        const currentTimeLabel = new Gtk.Label({ label: 'N/A' });
        currentTimeRow.add_suffix(currentTimeLabel);
        debugGroup.add(currentTimeRow);

        const lightTimeRow = new Adw.ActionRow({ title: 'Light Mode Switch Time' });
        const lightTimeLabel = new Gtk.Label({ label: 'N/A' });
        lightTimeRow.add_suffix(lightTimeLabel);
        debugGroup.add(lightTimeRow);

        const darkTimeRow = new Adw.ActionRow({ title: 'Dark Mode Switch Time' });
        const darkTimeLabel = new Gtk.Label({ label: 'N/A' });
        darkTimeRow.add_suffix(darkTimeLabel);
        debugGroup.add(darkTimeRow);

        const nextEventRow = new Adw.ActionRow({ title: 'Next Switch At' });
        const nextEventLabel = new Gtk.Label({ label: 'N/A' });
        nextEventRow.add_suffix(nextEventLabel);
        debugGroup.add(nextEventRow);

        const nextEventTypeRow = new Adw.ActionRow({ title: 'Next Switch Type' });
        const nextEventTypeLabel = new Gtk.Label({ label: 'N/A' });
        nextEventTypeRow.add_suffix(nextEventTypeLabel);
        debugGroup.add(nextEventTypeRow);

        const timeToNextRow = new Adw.ActionRow({ title: 'Time to Next Switch' });
        const timeToNextLabel = new Gtk.Label({ label: 'N/A' });
        timeToNextRow.add_suffix(timeToNextLabel);
        debugGroup.add(timeToNextRow);

        // Location info from API
        const locationInfoGroup = new Adw.PreferencesGroup({ title: 'Location Information' });
        debugPage.add(locationInfoGroup);

        const locationNameRow = new Adw.ActionRow({ title: 'Detected Location' });
        const locationNameLabel = new Gtk.Label({ label: 'N/A' });
        locationNameRow.add_suffix(locationNameLabel);
        locationInfoGroup.add(locationNameRow);

        const coordinatesRow = new Adw.ActionRow({ title: 'Coordinates' });
        const coordinatesLabel = new Gtk.Label({ label: 'N/A' });
        coordinatesRow.add_suffix(coordinatesLabel);
        locationInfoGroup.add(coordinatesRow);

        const timezoneRow = new Adw.ActionRow({ title: 'Timezone' });
        const timezoneLabel = new Gtk.Label({ label: 'N/A' });
        timezoneRow.add_suffix(timezoneLabel);
        locationInfoGroup.add(timezoneRow);

        // Brightness control information
        const brightnessInfoGroup = new Adw.PreferencesGroup({ title: 'Brightness Control' });
        debugPage.add(brightnessInfoGroup);

        const brightnessEnabledRow = new Adw.ActionRow({ title: 'Brightness Control Status' });
        const brightnessEnabledLabel = new Gtk.Label({ label: 'N/A' });
        brightnessEnabledRow.add_suffix(brightnessEnabledLabel);
        brightnessInfoGroup.add(brightnessEnabledRow);

        // Expandable row for detailed brightness info
        const brightnessDetailsExpander = new Adw.ExpanderRow({
            title: 'Brightness Details',
            subtitle: 'Click to expand',
        });
        brightnessInfoGroup.add(brightnessDetailsExpander);

        // Light brightness setting
        const lightBrightnessInfoRow = new Adw.ActionRow({ title: 'Light Mode Brightness' });
        const lightBrightnessInfoLabel = new Gtk.Label({ label: 'N/A' });
        lightBrightnessInfoRow.add_suffix(lightBrightnessInfoLabel);
        brightnessDetailsExpander.add_row(lightBrightnessInfoRow);

        // Dark brightness setting
        const darkBrightnessInfoRow = new Adw.ActionRow({ title: 'Dark Mode Brightness' });
        const darkBrightnessInfoLabel = new Gtk.Label({ label: 'N/A' });
        darkBrightnessInfoRow.add_suffix(darkBrightnessInfoLabel);
        brightnessDetailsExpander.add_row(darkBrightnessInfoRow);

        // Current calculated brightness
        const currentBrightnessRow = new Adw.ActionRow({ title: 'Current Calculated Brightness' });
        const currentBrightnessLabel = new Gtk.Label({ label: 'N/A' });
        currentBrightnessRow.add_suffix(currentBrightnessLabel);
        brightnessDetailsExpander.add_row(currentBrightnessRow);

        // Brightness trend
        const brightnessTrendRow = new Adw.ActionRow({ title: 'Brightness Trend' });
        const brightnessTrendLabel = new Gtk.Label({ label: 'N/A' });
        brightnessTrendRow.add_suffix(brightnessTrendLabel);
        brightnessDetailsExpander.add_row(brightnessTrendRow);

        // Brightness state (e.g., "Stable at 100%" or "Dimming (45%)")
        const brightnessStateRow = new Adw.ActionRow({ title: 'Brightness State' });
        const brightnessStateLabel = new Gtk.Label({ label: 'N/A' });
        brightnessStateRow.add_suffix(brightnessStateLabel);
        brightnessDetailsExpander.add_row(brightnessStateRow);

        // Next transition info
        const nextTransitionRow = new Adw.ActionRow({ title: 'Next Transition' });
        const nextTransitionLabel = new Gtk.Label({ label: 'N/A' });
        nextTransitionRow.add_suffix(nextTransitionLabel);
        brightnessDetailsExpander.add_row(nextTransitionRow);

        // Test controls
        const testGroup = new Adw.PreferencesGroup({ title: 'Manual Testing' });
        debugPage.add(testGroup);

        const darkTestRow = new Adw.ActionRow({
            title: 'Preview Dark Theme',
            subtitle: 'Switch to dark theme for testing',
        });
        const darkTestButton = new Gtk.Button({
            label: 'Apply Dark',
            valign: Gtk.Align.CENTER,
        });
        darkTestButton.connect('clicked', () => {
            this._callExtensionMethod('forceThemeSwitch', [true]);
        });
        darkTestRow.add_suffix(darkTestButton);
        testGroup.add(darkTestRow);

        const lightTestRow = new Adw.ActionRow({
            title: 'Preview Light Theme',
            subtitle: 'Switch to light theme for testing',
        });
        const lightTestButton = new Gtk.Button({
            label: 'Apply Light',
            valign: Gtk.Align.CENTER,
        });
        lightTestButton.connect('clicked', () => {
            this._callExtensionMethod('forceThemeSwitch', [false]);
        });
        lightTestRow.add_suffix(lightTestButton);
        testGroup.add(lightTestRow);

        const resetRow = new Adw.ActionRow({
            title: 'Reset to Automatic',
            subtitle: 'Return to automatic theme switching',
        });
        const resetButton = new Gtk.Button({
            label: 'Reset',
            valign: Gtk.Align.CENTER,
        });
        resetButton.add_css_class('suggested-action');
        resetButton.connect('clicked', () => {
            this._callExtensionMethod('resetToAutomatic', []);
        });
        resetRow.add_suffix(resetButton);
        testGroup.add(resetRow);

        const refreshRow = new Adw.ActionRow({
            title: 'Refresh Debug Info',
            subtitle: 'Update debug information display',
        });
        const refreshButton = new Gtk.Button({
            label: 'Refresh',
            valign: Gtk.Align.CENTER,
        });
        refreshButton.connect('clicked', () => {
            this._updateDebugInfo();
        });
        refreshRow.add_suffix(refreshButton);
        testGroup.add(refreshRow);

        // Add debug page to window
        window.add(debugPage);

        // Store labels for updating
        this._debugLabels = {
            currentMode: currentModeLabel,
            currentTime: currentTimeLabel,
            lightTime: lightTimeLabel,
            darkTime: darkTimeLabel,
            nextEvent: nextEventLabel,
            nextEventType: nextEventTypeLabel,
            timeToNext: timeToNextLabel,
            locationName: locationNameLabel,
            coordinates: coordinatesLabel,
            timezone: timezoneLabel,
            brightnessEnabled: brightnessEnabledLabel,
            lightBrightnessInfo: lightBrightnessInfoLabel,
            darkBrightnessInfo: darkBrightnessInfoLabel,
            currentBrightness: currentBrightnessLabel,
            brightnessTrend: brightnessTrendLabel,
            brightnessState: brightnessStateLabel,
            nextTransition: nextTransitionLabel,
        };

        // Store the next event time for countdown calculation
        this._nextEventTimestamp = null;

        // Update current time and countdown every second
        this._timeUpdateId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, DEBUG_TIME_UPDATE_INTERVAL_SECONDS, () => {
            // Update current time
            const now = new Date();
            currentTimeLabel.set_label(now.toLocaleString());

            // Update countdown if we have a next event time
            if (this._nextEventTimestamp) {
                const secondsRemaining = Math.max(0, Math.round((this._nextEventTimestamp - now.getTime()) / MS_PER_SECOND));
                const hours = Math.floor(secondsRemaining / 3600);
                const minutes = Math.floor((secondsRemaining % 3600) / 60);
                const seconds = secondsRemaining % 60;
                timeToNextLabel.set_label(`${hours}h ${minutes}m ${seconds}s`);
            }

            return GLib.SOURCE_CONTINUE;
        });

        // Auto-refresh full debug info every 5 seconds
        this._debugRefreshId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, DEBUG_INFO_REFRESH_INTERVAL_SECONDS, () => {
            this._updateDebugInfo();
            return GLib.SOURCE_CONTINUE;
        });

        // Initial update
        this._updateDebugInfo();

        // Store signal handler IDs for cleanup
        this._settingsSignalIds = [];

        // Track settings signal connections for cleanup
        const trackSignal = (signalId) => {
            this._settingsSignalIds.push(signalId);
            return signalId;
        };

        // Update the existing settings.connect calls to track signal IDs
        // (Note: These were connected earlier in the code but not tracked)
        // We'll disconnect them in the close-request handler below

        // Clean up timers and references when window closes for proper garbage collection
        window.connect('close-request', () => {
            // Clean up time update timer
            try {
                if (this._timeUpdateId) {
                    GLib.source_remove(this._timeUpdateId);
                    this._timeUpdateId = null;
                }
            } catch (e) {
                console.error(`Failed to remove time update timer: ${e}`);
            }

            // Clean up debug refresh timer
            try {
                if (this._debugRefreshId) {
                    GLib.source_remove(this._debugRefreshId);
                    this._debugRefreshId = null;
                }
            } catch (e) {
                console.error(`Failed to remove debug refresh timer: ${e}`);
            }

            // Disconnect all settings signal handlers
            // Note: GSettings signal handlers should be disconnected, but they're created
            // throughout the code without tracking. While not critical for prefs (which
            // is short-lived), it's good practice to clean up properly.
            // For now, we'll just null out the settings reference.
            try {
                this.settings = null;
            } catch (e) {
                console.error(`Failed to null settings: ${e}`);
            }

            // Clear widget references to allow garbage collection
            try {
                this._debugLabels = null;
                this._nextEventTimestamp = null;
            } catch (e) {
                console.error(`Failed to clear widget references: ${e}`);
            }

            return false;
        });
    }

    _updateDebugInfo() {
        try {
            const debugInfo = this._getExtensionDebugInfo();
            if (debugInfo && this._debugLabels) {
                this._debugLabels.currentMode.set_label(debugInfo.currentMode || 'N/A');
                this._debugLabels.currentTime.set_label(debugInfo.currentTime || 'N/A');
                this._debugLabels.lightTime.set_label(debugInfo.lightTime || 'N/A');
                this._debugLabels.darkTime.set_label(debugInfo.darkTime || 'N/A');
                this._debugLabels.nextEvent.set_label(debugInfo.nextEventTime || 'N/A');
                this._debugLabels.nextEventType.set_label(debugInfo.nextEventType || 'N/A');

                // Store the timestamp for countdown calculation
                if (debugInfo.secondsToNextEvent) {
                    // Calculate the timestamp based on current time + seconds remaining
                    const now = new Date();
                    this._nextEventTimestamp = now.getTime() + (debugInfo.secondsToNextEvent * MS_PER_SECOND);
                }

                // Initial countdown display (will be updated every second)
                const seconds = debugInfo.secondsToNextEvent || 0;
                const hours = Math.floor(seconds / 3600);
                const minutes = Math.floor((seconds % 3600) / 60);
                const secs = seconds % 60;
                this._debugLabels.timeToNext.set_label(`${hours}h ${minutes}m ${secs}s`);

                // Location information
                this._debugLabels.locationName.set_label(debugInfo.locationName || 'Unknown');

                if (debugInfo.latitude && debugInfo.longitude) {
                    this._debugLabels.coordinates.set_label(`${debugInfo.latitude}, ${debugInfo.longitude}`);
                }

                if (debugInfo.apiData && debugInfo.apiData.timezone) {
                    this._debugLabels.timezone.set_label(debugInfo.apiData.timezone);
                }

                // Brightness information
                if (debugInfo.brightness) {
                    this._debugLabels.brightnessEnabled.set_label(
                        debugInfo.brightness.enabled ? 'Enabled' : 'Disabled'
                    );
                    this._debugLabels.lightBrightnessInfo.set_label(
                        debugInfo.brightness.lightBrightness || 'N/A'
                    );
                    this._debugLabels.darkBrightnessInfo.set_label(
                        debugInfo.brightness.darkBrightness || 'N/A'
                    );
                    this._debugLabels.currentBrightness.set_label(
                        debugInfo.brightness.currentBrightness || 'N/A'
                    );
                    this._debugLabels.brightnessTrend.set_label(
                        debugInfo.brightness.trend || 'N/A'
                    );
                    this._debugLabels.brightnessState.set_label(
                        debugInfo.brightness.brightnessState || 'N/A'
                    );
                    this._debugLabels.nextTransition.set_label(
                        debugInfo.brightness.nextTransition || 'N/A'
                    );
                }
            }
        } catch (e) {
            console.error(`Failed to update debug info: ${e}`);
        }
    }

    _getExtensionDebugInfo() {
        try {
            const result = Gio.DBus.session.call_sync(
                'org.gnome.Shell',
                '/org/gnome/Shell/Extensions/AutoThemeSwitcher',
                'org.gnome.Shell.Extensions.AutoThemeSwitcher',
                'GetDebugInfo',
                null,
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null
            );
            const [jsonString] = result.deep_unpack();
            return JSON.parse(jsonString);
        } catch (e) {
            console.error(`Failed to get debug info: ${e}`);
            return null;
        }
    }

    _callExtensionMethod(method, args) {
        try {
            if (method === 'forceThemeSwitch') {
                Gio.DBus.session.call_sync(
                    'org.gnome.Shell',
                    '/org/gnome/Shell/Extensions/AutoThemeSwitcher',
                    'org.gnome.Shell.Extensions.AutoThemeSwitcher',
                    'ForceThemeSwitch',
                    new GLib.Variant('(b)', args),
                    null,
                    Gio.DBusCallFlags.NONE,
                    -1,
                    null
                );
            } else if (method === 'resetToAutomatic') {
                Gio.DBus.session.call_sync(
                    'org.gnome.Shell',
                    '/org/gnome/Shell/Extensions/AutoThemeSwitcher',
                    'org.gnome.Shell.Extensions.AutoThemeSwitcher',
                    'ResetToAutomatic',
                    null,
                    null,
                    Gio.DBusCallFlags.NONE,
                    -1,
                    null
                );
            }
        } catch (e) {
            console.error(`Failed to call extension method ${method}: ${e}`);
        }
    }

    _checkBrightnessctl() {
        try {
            const [success, stdout, stderr, exitStatus] = GLib.spawn_command_line_sync('which brightnessctl');
            return exitStatus === 0;
        } catch (e) {
            return false;
        }
    }

    _initializeBrightnessValues(lightScale, darkScale) {
        // Get current brightness and set both sliders to that value on first run
        try {
            const [success, stdout] = GLib.spawn_command_line_sync('brightnessctl get');
            if (success) {
                const currentBrightness = parseInt(new TextDecoder().decode(stdout).trim());

                // Get max brightness
                const [maxSuccess, maxStdout] = GLib.spawn_command_line_sync('brightnessctl max');
                if (maxSuccess) {
                    const maxBrightness = parseInt(new TextDecoder().decode(maxStdout).trim());
                    const currentPercent = Math.round((currentBrightness / maxBrightness) * 100);

                    // If settings are at defaults (100 and 50), set both to current
                    const lightBrightness = this.settings.get_int('light-brightness');
                    const darkBrightness = this.settings.get_int('dark-brightness');

                    if (lightBrightness === 100 && darkBrightness === 50) {
                        lightScale.set_value(currentPercent);
                        darkScale.set_value(currentPercent);
                        this.settings.set_int('light-brightness', currentPercent);
                        this.settings.set_int('dark-brightness', currentPercent);
                    }
                }
            }
        } catch (e) {
            console.error(`Failed to get current brightness: ${e}`);
        }
    }
}

