import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {
    DEBUG_TIME_UPDATE_INTERVAL_SECONDS,
    DEBUG_INFO_REFRESH_INTERVAL_SECONDS,
    MS_PER_SECOND,
} from './constants.js';
import { MonitorConfigDialog } from './prefs/externalMonitorDialog.js';
import { debugLog, debugWarn, setDebugLogging } from './logger.js';

export default class ThemeSwitcherPreferences extends ExtensionPreferences {
    /**
     * Get available GTK themes from all standard theme directories
     * Handles NixOS and other non-standard Linux distributions
     */
    _getAvailableThemes() {
        const themes = new Set();
        const themeDirs = [];

        // User theme directories
        const homeDir = GLib.get_home_dir();
        themeDirs.push(GLib.build_filenamev([homeDir, '.themes']));
        themeDirs.push(GLib.build_filenamev([homeDir, '.local', 'share', 'themes']));

        // System theme directories from XDG_DATA_DIRS (works on NixOS)
        const dataDirs = GLib.get_system_data_dirs();
        for (const dataDir of dataDirs) {
            themeDirs.push(GLib.build_filenamev([dataDir, 'themes']));
        }

        // Check each directory for themes
        for (const dirPath of themeDirs) {
            try {
                const dir = Gio.File.new_for_path(dirPath);
                if (!dir.query_exists(null)) {
                    continue;
                }

                const enumerator = dir.enumerate_children(
                    'standard::name,standard::type',
                    Gio.FileQueryInfoFlags.NONE,
                    null
                );

                let info;
                while ((info = enumerator.next_file(null))) {
                    const name = info.get_name();

                    // Skip hidden folders
                    if (name.startsWith('.')) {
                        continue;
                    }

                    // Add directories and symbolic links (NixOS uses symlinks to Nix store)
                    const fileType = info.get_file_type();
                    if (fileType === Gio.FileType.DIRECTORY ||
                        fileType === Gio.FileType.SYMBOLIC_LINK) {
                        themes.add(name);
                    }
                }
            } catch (e) {
                // Directory doesn't exist or isn't readable - skip it
                debugLog(`Prefs: Could not read theme directory ${dirPath}: ${e.message}`);
            }
        }

        // Convert to sorted array
        return Array.from(themes).sort((a, b) => a.localeCompare(b));
    }

    fillPreferencesWindow(window) {
        debugLog('Prefs: fillPreferencesWindow called');
        this.settings = this.getSettings();
        this._settingsSignalIds = [];  // Track settings signals for cleanup
        this._locationSession = null;  // Track Soup.Session for cleanup

        // The prefs process has its own logger instance — sync it with the
        // setting now and on every change from the Status-tab toggle.
        setDebugLogging(this.settings.get_boolean('debug-logging'));
        this._settingsSignalIds.push(this.settings.connect('changed::debug-logging', () => {
            setDebugLogging(this.settings.get_boolean('debug-logging'));
        }));
        debugLog(`Prefs: Got settings with schema: ${this.settings.schema_id}`);

        const page = new Adw.PreferencesPage({
            title: 'Settings',
            icon_name: 'preferences-system-symbolic',
        });

        // --- Manual Override banner (shown only while manual mode is active) ---
        // Pinned at the TOP of the Settings page so the user can see at a glance
        // that the auto schedule is paused and reset from any tab without
        // having to navigate to the Status tab. Visibility is bound to the
        // manual-mode-active GSettings key so it tracks both prefs button
        // clicks and the persisted state across extension reloads.
        const overrideGroup = new Adw.PreferencesGroup({ title: '⚠️ Manual Override is On' });
        const overrideRow = new Adw.ActionRow({
            subtitle: 'Click Reset to follow the day/night schedule again.',
        });
        const overrideResetButton = new Gtk.Button({
            label: 'Reset',
            valign: Gtk.Align.CENTER,
        });
        overrideResetButton.add_css_class('suggested-action');
        overrideResetButton.connect('clicked', () => {
            this._callExtensionMethod('resetToAutomatic', []);
        });
        overrideRow.add_suffix(overrideResetButton);
        overrideGroup.add(overrideRow);
        page.add(overrideGroup);

        const updateOverrideVisibility = () => {
            const active = this.settings.get_boolean('manual-mode-active');
            overrideGroup.set_visible(active);
            if (active) {
                const isDark = this.settings.get_boolean('manual-mode-is-dark');
                overrideRow.set_title(`Override set to ${isDark ? 'Dark' : 'Light'} mode`);
            }
        };
        updateOverrideVisibility();
        this._settingsSignalIds.push(this.settings.connect('changed::manual-mode-active', updateOverrideVisibility));
        this._settingsSignalIds.push(this.settings.connect('changed::manual-mode-is-dark', updateOverrideVisibility));

        // --- Theme Settings Group ---
        const themeGroup = new Adw.PreferencesGroup({ title: 'Theme Settings' });
        page.add(themeGroup);

        // Get available themes from all theme directories
        const availableThemes = this._getAvailableThemes();

        // Light Theme Dropdown
        const lightThemeRow = new Adw.ComboRow({
            title: 'Light Theme',
            subtitle: 'Theme to use during the day',
        });
        const lightThemeModel = new Gtk.StringList();
        for (const theme of availableThemes) {
            lightThemeModel.append(theme);
        }
        lightThemeRow.model = lightThemeModel;
        themeGroup.add(lightThemeRow);

        // Dark Theme Dropdown
        const darkThemeRow = new Adw.ComboRow({
            title: 'Dark Theme',
            subtitle: 'Theme to use at night',
        });
        const darkThemeModel = new Gtk.StringList();
        for (const theme of availableThemes) {
            darkThemeModel.append(theme);
        }
        darkThemeRow.model = darkThemeModel;
        themeGroup.add(darkThemeRow);

        // True Light Mode Toggle
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
        themeGroup.add(trueLightModeRow);

        // Notifications Toggle
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
        themeGroup.add(notificationsRow);

        // --- Timing Settings ---
        const timingGroup = new Adw.PreferencesGroup({ title: 'Theme Switch Timing' });
        page.add(timingGroup);

        // Status row - shows different states based on location configuration
        const timingInfoRow = new Adw.ActionRow({
            title: 'Configure your location below to use solar events',
            subtitle: 'Solar events include sunrise, sunset, dawn, dusk, and more',
            icon_name: 'dialog-information-symbolic',
        });
        timingGroup.add(timingInfoRow);

        // Light Mode Trigger - full-width dropdown with label above
        const lightTriggerBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12,
        });

        const lightTriggerLabel = new Gtk.Label({
            label: 'Light Mode',
            xalign: 0,
        });
        lightTriggerLabel.add_css_class('heading');
        lightTriggerBox.append(lightTriggerLabel);

        const lightTriggerModel = new Gtk.StringList();
        lightTriggerModel.append('First Hint of Light (astronomical dawn)');
        lightTriggerModel.append('Early Dawn (nautical twilight)');
        lightTriggerModel.append('Dawn (civil twilight)');
        lightTriggerModel.append('Sunrise');
        lightTriggerModel.append('Sun Fully Up');
        lightTriggerModel.append('Morning Golden Hour Ends');
        lightTriggerModel.append('Solar Noon');
        lightTriggerModel.append('Custom Time');

        const lightTriggerDropdown = new Gtk.DropDown({
            model: lightTriggerModel,
            hexpand: true,
        });
        lightTriggerBox.append(lightTriggerDropdown);

        const lightTriggerRow = new Adw.PreferencesRow({
            child: lightTriggerBox,
        });
        timingGroup.add(lightTriggerRow);

        const lightTriggerMap = {
            0: 'first-light',
            1: 'nautical-dawn',
            2: 'dawn',
            3: 'sunrise',
            4: 'sunrise-end',
            5: 'golden-hour-end',
            6: 'solar-noon',
            7: 'custom'
        };
        const savedLightTrigger = this.settings.get_string('light-mode-trigger');
        const lightTriggerIndex = Object.keys(lightTriggerMap).find(key => lightTriggerMap[key] === savedLightTrigger) || 3;
        lightTriggerDropdown.selected = parseInt(lightTriggerIndex);

        // Custom Light Time Entry
        const customLightTimeRow = new Adw.EntryRow({
            title: 'Light Mode Time',
            text: this.settings.get_string('custom-light-time'),
            show_apply_button: true,
        });
        customLightTimeRow.set_input_purpose(Gtk.InputPurpose.FREE_FORM);
        timingGroup.add(customLightTimeRow);

        // Dark Mode Trigger - full-width dropdown with label above
        const darkTriggerBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12,
        });

        const darkTriggerLabel = new Gtk.Label({
            label: 'Dark Mode',
            xalign: 0,
        });
        darkTriggerLabel.add_css_class('heading');
        darkTriggerBox.append(darkTriggerLabel);

        const darkTriggerModel = new Gtk.StringList();
        darkTriggerModel.append('Solar Noon');
        darkTriggerModel.append('Evening Golden Hour Begins');
        darkTriggerModel.append('Sunset Begins');
        darkTriggerModel.append('Sunset');
        darkTriggerModel.append('Dusk (civil twilight)');
        darkTriggerModel.append('Late Dusk (nautical twilight)');
        darkTriggerModel.append('Nightfall (astronomical dusk)');
        darkTriggerModel.append('Solar Midnight');
        darkTriggerModel.append('Custom Time');

        const darkTriggerDropdown = new Gtk.DropDown({
            model: darkTriggerModel,
            hexpand: true,
        });
        darkTriggerBox.append(darkTriggerDropdown);

        const darkTriggerRow = new Adw.PreferencesRow({
            child: darkTriggerBox,
        });
        timingGroup.add(darkTriggerRow);

        const darkTriggerMap = {
            0: 'solar-noon',
            1: 'golden-hour',
            2: 'sunset-start',
            3: 'sunset',
            4: 'dusk',
            5: 'nautical-dusk',
            6: 'last-light',
            7: 'nadir',
            8: 'custom'
        };
        const savedDarkTrigger = this.settings.get_string('dark-mode-trigger');
        const darkTriggerIndex = Object.keys(darkTriggerMap).find(key => darkTriggerMap[key] === savedDarkTrigger) || 3;
        darkTriggerDropdown.selected = parseInt(darkTriggerIndex);

        // Custom Dark Time Entry
        const customDarkTimeRow = new Adw.EntryRow({
            title: 'Dark Mode Time',
            text: this.settings.get_string('custom-dark-time'),
            show_apply_button: true,
        });
        customDarkTimeRow.set_input_purpose(Gtk.InputPurpose.FREE_FORM);
        timingGroup.add(customDarkTimeRow);

        // --- Location Settings (Collapsible) ---
        const locationGroup = new Adw.PreferencesGroup({
            title: 'Configure Location',
        });
        page.add(locationGroup);

        const locationExpander = new Adw.ExpanderRow({
            title: 'Location Settings',
            subtitle: this._getLocationSubtitle(),
            show_enable_switch: false,
        });
        locationGroup.add(locationExpander);

        // Latitude Entry - using Adw.EntryRow for proper styling
        const latitudeRow = new Adw.EntryRow({
            title: 'Latitude',
            text: this.settings.get_string('manual-latitude'),
        });
        latitudeRow.set_input_purpose(Gtk.InputPurpose.NUMBER);
        locationExpander.add_row(latitudeRow);

        // Longitude Entry - using Adw.EntryRow for proper styling
        const longitudeRow = new Adw.EntryRow({
            title: 'Longitude',
            text: this.settings.get_string('manual-longitude'),
        });
        longitudeRow.set_input_purpose(Gtk.InputPurpose.NUMBER);
        locationExpander.add_row(longitudeRow);

        // Auto-Detect Button row with info tooltip
        // Shows detected location name as subtitle when available
        const savedLocationName = this.settings.get_string('location-name');
        const autoDetectRow = new Adw.ActionRow({
            title: 'Detect My Location',
            subtitle: savedLocationName || 'Automatically detect your approximate location',
        });

        // Info button with tooltip
        const infoButton = new Gtk.MenuButton({
            icon_name: 'dialog-information-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: [
                'About Auto-Detection:',
                '',
                '• Uses ipinfo.io to estimate location from your IP',
                '• Location is approximate and may be inaccurate',
                '• VPN users may get incorrect results',
                '• Location is saved locally - detect once unless you move',
                '• Please use sparingly - free service has rate limits',
            ].join('\n'),
        });
        infoButton.add_css_class('flat');
        // Remove the popover since we're using tooltip only
        infoButton.set_popover(null);

        const autoDetectSpinner = new Gtk.Spinner({
            valign: Gtk.Align.CENTER,
        });
        autoDetectSpinner.visible = false;

        const autoDetectButton = new Gtk.Button({
            label: 'Detect',
            valign: Gtk.Align.CENTER,
        });
        autoDetectButton.add_css_class('suggested-action');

        autoDetectRow.add_suffix(infoButton);
        autoDetectRow.add_suffix(autoDetectSpinner);
        autoDetectRow.add_suffix(autoDetectButton);
        autoDetectRow.set_activatable_widget(autoDetectButton);
        locationExpander.add_row(autoDetectRow);

        // Auto-detect button handler
        autoDetectButton.connect('clicked', () => {
            this._autoDetectLocation(
                autoDetectButton,
                autoDetectSpinner,
                latitudeRow,
                longitudeRow,
                autoDetectRow,
                locationExpander
            );
        });

        // Update expander subtitle when coordinates change
        const updateLocationSubtitle = () => {
            locationExpander.set_subtitle(this._getLocationSubtitle());
        };
        this._settingsSignalIds.push(this.settings.connect('changed::manual-latitude', updateLocationSubtitle));
        this._settingsSignalIds.push(this.settings.connect('changed::manual-longitude', updateLocationSubtitle));
        this._settingsSignalIds.push(this.settings.connect('changed::location-name', updateLocationSubtitle));

        // When coordinates are manually changed, clear the location name
        // (Auto-detect will set it back immediately after setting coordinates)
        const clearLocationNameOnManualChange = () => {
            this.settings.set_string('location-name', '');
            autoDetectRow.set_subtitle('Automatically detect your approximate location');
        };
        latitudeRow.connect('notify::text', clearLocationNameOnManualChange);
        longitudeRow.connect('notify::text', clearLocationNameOnManualChange);

        // --- Visibility Logic for Triggers ---
        const hasCoordinates = () => {
            const lat = this.settings.get_string('manual-latitude');
            const lng = this.settings.get_string('manual-longitude');
            return lat && lng && lat.trim() !== '' && lng.trim() !== '';
        };

        const updateTriggerVisibility = () => {
            const coordsSet = hasCoordinates();

            if (coordsSet) {
                // Location is set - update info row to success state, show solar events dropdowns
                timingInfoRow.set_icon_name('emblem-ok-symbolic');
                timingInfoRow.set_title('Location configured');
                timingInfoRow.set_subtitle('Solar events are now available for automatic theme switching');

                lightTriggerRow.visible = true;
                darkTriggerRow.visible = true;

                // Show custom time row only if "Custom Time" is selected
                const lightIsCustom = lightTriggerDropdown.selected === 7;
                const darkIsCustom = darkTriggerDropdown.selected === 8;
                customLightTimeRow.visible = lightIsCustom;
                customDarkTimeRow.visible = darkIsCustom;
            } else {
                // No location - show info row with prompt, hide solar events dropdowns, show time entries
                timingInfoRow.set_icon_name('dialog-information-symbolic');
                timingInfoRow.set_title('Configure your location below to use solar events');
                timingInfoRow.set_subtitle('Solar events include sunrise, sunset, dawn, dusk, and more');

                lightTriggerRow.visible = false;
                darkTriggerRow.visible = false;

                // Always show custom time rows when no coordinates
                customLightTimeRow.visible = true;
                customDarkTimeRow.visible = true;
            }
        };

        // Initial visibility update
        updateTriggerVisibility();

        // Update on settings changes
        this._settingsSignalIds.push(this.settings.connect('changed::manual-latitude', updateTriggerVisibility));
        this._settingsSignalIds.push(this.settings.connect('changed::manual-longitude', updateTriggerVisibility));

        // Connect trigger dropdown selection changes
        lightTriggerDropdown.connect('notify::selected', () => {
            this.settings.set_string('light-mode-trigger', lightTriggerMap[lightTriggerDropdown.selected]);
            updateTriggerVisibility();
        });

        darkTriggerDropdown.connect('notify::selected', () => {
            this.settings.set_string('dark-mode-trigger', darkTriggerMap[darkTriggerDropdown.selected]);
            updateTriggerVisibility();
        });

        // Connect time entry changes
        customLightTimeRow.connect('apply', () => {
            this.settings.set_string('custom-light-time', customLightTimeRow.get_text());
        });
        customDarkTimeRow.connect('apply', () => {
            this.settings.set_string('custom-dark-time', customDarkTimeRow.get_text());
        });

        // --- Brightness Control ---
        const brightnessGroup = new Adw.PreferencesGroup({ title: 'Brightness Control' });
        page.add(brightnessGroup);

        let hasBrightnessctl = false;

        const controlBrightnessRow = new Adw.ActionRow({
            title: 'Control Brightness',
            subtitle: 'Checking for brightnessctl...',
        });
        const controlBrightnessToggle = new Gtk.Switch({
            active: false,
            sensitive: false,
            valign: Gtk.Align.CENTER,
        });
        controlBrightnessRow.add_suffix(controlBrightnessToggle);
        brightnessGroup.add(controlBrightnessRow);

        // Installation instructions expander
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

        // Helper to add copyable command
        const addCopyableCommand = (container, command) => {
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
                const clipboard = window.get_display().get_clipboard();
                clipboard.set(command);
            });
            commandBox.append(commandEntry);
            commandBox.append(copyButton);
            container.append(commandBox);
        };

        // Introduction
        const introLabel = new Gtk.Label({
            label: 'brightnessctl is required to control the built-in display brightness. Follow ALL steps below carefully.',
            xalign: 0,
            wrap: true,
        });
        introLabel.add_css_class('dim-label');
        installBox.append(introLabel);

        // Step 1: Install brightnessctl
        const step1Label = new Gtk.Label({
            label: 'Step 1: Install brightnessctl',
            xalign: 0,
            wrap: true,
            margin_top: 12,
        });
        step1Label.add_css_class('heading');
        installBox.append(step1Label);

        const distroInstallNote = new Gtk.Label({
            label: 'Ubuntu/Debian: sudo apt install brightnessctl\nFedora: sudo dnf install brightnessctl\nArch: sudo pacman -S brightnessctl\nNixOS: Add "brightnessctl" to environment.systemPackages',
            xalign: 0,
            wrap: true,
        });
        distroInstallNote.add_css_class('dim-label');
        installBox.append(distroInstallNote);

        // Step 2: Add user to video group
        const step2Label = new Gtk.Label({
            label: 'Step 2: Add your user to the video group',
            xalign: 0,
            wrap: true,
            margin_top: 12,
        });
        step2Label.add_css_class('heading');
        installBox.append(step2Label);

        const videoGroupNote = new Gtk.Label({
            label: 'This allows non-root access to backlight controls:',
            xalign: 0,
            wrap: true,
        });
        videoGroupNote.add_css_class('dim-label');
        installBox.append(videoGroupNote);

        addCopyableCommand(installBox, 'sudo usermod -aG video $USER');

        const nixosNote = new Gtk.Label({
            label: 'NixOS: Add your user to the "video" group in configuration.nix',
            xalign: 0,
            wrap: true,
            margin_top: 6,
        });
        nixosNote.add_css_class('dim-label');
        installBox.append(nixosNote);

        // Step 3: Reboot
        const step3Label = new Gtk.Label({
            label: 'Step 3: Log out and log back in (or reboot)',
            xalign: 0,
            wrap: true,
            margin_top: 12,
        });
        step3Label.add_css_class('heading');
        installBox.append(step3Label);

        const rebootNote = new Gtk.Label({
            label: 'IMPORTANT: You must log out and log back in for the group membership to take effect. A full reboot is recommended.',
            xalign: 0,
            wrap: true,
        });
        rebootNote.add_css_class('dim-label');
        installBox.append(rebootNote);

        // Step 4: Verify
        const step4Label = new Gtk.Label({
            label: 'Step 4: Verify installation',
            xalign: 0,
            wrap: true,
            margin_top: 12,
        });
        step4Label.add_css_class('heading');
        installBox.append(step4Label);

        const verifyLabel = new Gtk.Label({
            label: 'After logging back in, verify the setup:',
            xalign: 0,
            wrap: true,
        });
        verifyLabel.add_css_class('dim-label');
        installBox.append(verifyLabel);

        const verifyStep1 = new Gtk.Label({
            label: '1. Check group membership (should show "video"):',
            xalign: 0,
            wrap: true,
            margin_top: 6,
        });
        verifyStep1.add_css_class('dim-label');
        installBox.append(verifyStep1);

        addCopyableCommand(installBox, 'groups | grep video');

        const verifyStep2 = new Gtk.Label({
            label: '2. Test brightness control (should show current brightness):',
            xalign: 0,
            wrap: true,
            margin_top: 6,
        });
        verifyStep2.add_css_class('dim-label');
        installBox.append(verifyStep2);

        addCopyableCommand(installBox, 'brightnessctl get');

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
            label: 'If "brightnessctl get" fails:\n• Ensure you logged out and back in after adding to video group\n• Some desktop displays may not have backlight control\n• Virtual machines typically do not have backlight devices\n• Run "brightnessctl -l" to list available devices',
            xalign: 0,
            wrap: true,
        });
        troubleNote.add_css_class('dim-label');
        installBox.append(troubleNote);

        installExpander.add_row(new Adw.PreferencesRow({ child: installBox }));
        brightnessGroup.add(installExpander);
        installExpander.visible = false;

        // Configure Monitors button
        const configureMonitorsRow = new Adw.ActionRow({
            title: 'Configure Monitors',
            subtitle: 'Configure brightness for built-in and external monitors',
        });

        const configureButton = new Gtk.Button({
            label: 'Configure...',
            valign: Gtk.Align.CENTER,
        });

        configureButton.connect('clicked', () => {
            const dialog = new MonitorConfigDialog(window, this.settings);
            dialog.show();
        });

        configureMonitorsRow.add_suffix(configureButton);
        configureMonitorsRow.set_activatable_widget(configureButton);
        brightnessGroup.add(configureMonitorsRow);
        configureMonitorsRow.visible = false;

        // Monitor status display update
        const updateMonitorStatus = () => {
            try {
                const json = this.settings.get_string('monitors');
                const monitors = JSON.parse(json);

                if (Array.isArray(monitors) && monitors.length > 0) {
                    const enabledCount = monitors.filter(m => m.enabled && m.initialized).length;
                    const totalCount = monitors.length;
                    const lastDetection = this.settings.get_int64('monitors-last-detection');

                    let statusText = `${enabledCount} of ${totalCount} monitor${totalCount > 1 ? 's' : ''} enabled`;

                    if (lastDetection > 0) {
                        const elapsed = Date.now() - lastDetection;
                        const minutes = Math.round(elapsed / 60000);

                        if (minutes < 1) {
                            statusText += ' • Just detected';
                        } else if (minutes < 60) {
                            statusText += ` • Last detected ${minutes}m ago`;
                        } else {
                            const hours = Math.round(minutes / 60);
                            statusText += ` • Last detected ${hours}h ago`;
                        }
                    }

                    configureMonitorsRow.set_subtitle(statusText);
                }
            } catch (e) {
                // Ignore errors
            }
        };

        // Async check for brightnessctl
        this._checkBrightnessctl().then(available => {
            hasBrightnessctl = available;

            if (available) {
                controlBrightnessRow.set_subtitle('Gradually adjust screen brightness throughout the day');
                controlBrightnessToggle.sensitive = true;
                controlBrightnessRow.activatable_widget = controlBrightnessToggle;
                installExpander.visible = false;
                configureMonitorsRow.visible = true;

                this.settings.bind('control-brightness', controlBrightnessToggle, 'active', Gio.SettingsBindFlags.DEFAULT);

                updateMonitorStatus();
                this._settingsSignalIds.push(this.settings.connect('changed::monitors', updateMonitorStatus));
                this._settingsSignalIds.push(this.settings.connect('changed::monitors-last-detection', updateMonitorStatus));
            } else {
                controlBrightnessRow.set_subtitle('Package not found - see installation instructions below');
                controlBrightnessToggle.sensitive = false;
                installExpander.visible = true;
                configureMonitorsRow.visible = false;

                this.settings.set_boolean('control-brightness', false);
                controlBrightnessToggle.active = false;
            }
        }).catch(e => {
            console.error(`Prefs: Failed to check brightnessctl availability: ${e}`);
            controlBrightnessRow.set_subtitle('Package not found - see installation instructions below');
            installExpander.visible = true;
        });

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
        nightLightModeRow.selected = parseInt(nightLightIndex);

        // Night Light Custom Schedule Times
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
            this.settings.set_string('night-light-mode', nightLightMap[nightLightModeRow.selected]);
        });

        // --- Bind settings to UI widgets ---
        const savedLightTheme = this.settings.get_string('light-theme');
        const savedDarkTheme = this.settings.get_string('dark-theme');

        for (let i = 0; i < lightThemeModel.get_n_items(); i++) {
            if (lightThemeModel.get_string(i) === savedLightTheme) {
                lightThemeRow.selected = i;
                break;
            }
        }

        for (let i = 0; i < darkThemeModel.get_n_items(); i++) {
            if (darkThemeModel.get_string(i) === savedDarkTheme) {
                darkThemeRow.selected = i;
                break;
            }
        }

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

        this.settings.bind('manual-latitude', latitudeRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        this.settings.bind('manual-longitude', longitudeRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        this.settings.bind('true-light-mode', trueLightModeToggle, 'active', Gio.SettingsBindFlags.DEFAULT);
        this.settings.bind('show-notifications', notificationsToggle, 'active', Gio.SettingsBindFlags.DEFAULT);
        // Note: custom-light-time and custom-dark-time are handled via apply signal on EntryRows
        this.settings.bind('night-light-start-time', nightLightStartEntry, 'text', Gio.SettingsBindFlags.DEFAULT);
        this.settings.bind('night-light-end-time', nightLightEndEntry, 'text', Gio.SettingsBindFlags.DEFAULT);

        window.add(page);

        // --- Status Page ---
        const debugPage = new Adw.PreferencesPage({
            title: 'Status',
            icon_name: 'dialog-information-symbolic',
        });

        const debugGroup = new Adw.PreferencesGroup({ title: 'Schedule Status' });
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

        const calculationMethodRow = new Adw.ActionRow({ title: 'Calculation Method' });
        const calculationMethodLabel = new Gtk.Label({ label: 'N/A' });
        calculationMethodRow.add_suffix(calculationMethodLabel);
        debugGroup.add(calculationMethodRow);

        // Location info
        const locationInfoGroup = new Adw.PreferencesGroup({ title: 'Location Information' });
        debugPage.add(locationInfoGroup);

        const debugLocationNameRow = new Adw.ActionRow({ title: 'Location' });
        const debugLocationNameLabel = new Gtk.Label({ label: 'N/A' });
        debugLocationNameRow.add_suffix(debugLocationNameLabel);
        locationInfoGroup.add(debugLocationNameRow);

        const coordinatesRow = new Adw.ActionRow({ title: 'Coordinates' });
        const coordinatesLabel = new Gtk.Label({ label: 'N/A' });
        coordinatesRow.add_suffix(coordinatesLabel);
        locationInfoGroup.add(coordinatesRow);

        const timezoneRow = new Adw.ActionRow({ title: 'Timezone' });
        const timezoneLabel = new Gtk.Label({ label: 'N/A' });
        timezoneRow.add_suffix(timezoneLabel);
        locationInfoGroup.add(timezoneRow);

        // Solar times group with Today and Tomorrow sections
        const solarTimesGroup = new Adw.PreferencesGroup({ title: 'Calculated Solar Times' });
        debugPage.add(solarTimesGroup);

        // Helper function to create solar event rows
        const createSolarEventRows = (expander) => {
            const labels = {};

            const events = [
                { key: 'firstLight', title: 'First Hint of Light' },
                { key: 'nauticalDawn', title: 'Early Dawn' },
                { key: 'dawn', title: 'Dawn' },
                { key: 'sunrise', title: 'Sunrise' },
                { key: 'sunriseEnd', title: 'Sun Fully Up' },
                { key: 'goldenHourEnd', title: 'Morning Golden Hour Ends' },
                { key: 'solarNoon', title: 'Solar Noon' },
                { key: 'goldenHour', title: 'Evening Golden Hour Begins' },
                { key: 'sunsetStart', title: 'Sunset Begins' },
                { key: 'sunset', title: 'Sunset' },
                { key: 'dusk', title: 'Dusk' },
                { key: 'nauticalDusk', title: 'Late Dusk' },
                { key: 'lastLight', title: 'Nightfall' },
            ];

            for (const event of events) {
                const row = new Adw.ActionRow({ title: event.title });
                const label = new Gtk.Label({ label: 'N/A' });
                row.add_suffix(label);
                expander.add_row(row);
                labels[event.key] = label;
            }

            return labels;
        };

        // Today's solar events
        const todayExpander = new Adw.ExpanderRow({
            title: 'Today',
            subtitle: 'Loading...',
        });
        solarTimesGroup.add(todayExpander);
        const todayLabels = createSolarEventRows(todayExpander);

        // Tomorrow's solar events
        const tomorrowExpander = new Adw.ExpanderRow({
            title: 'Tomorrow',
            subtitle: 'Loading...',
        });
        solarTimesGroup.add(tomorrowExpander);
        const tomorrowLabels = createSolarEventRows(tomorrowExpander);

        // Brightness control information
        const brightnessInfoGroup = new Adw.PreferencesGroup({ title: 'Brightness Control' });
        debugPage.add(brightnessInfoGroup);

        const brightnessEnabledRow = new Adw.ActionRow({ title: 'Brightness Control Status' });
        const brightnessEnabledLabel = new Gtk.Label({ label: 'N/A' });
        brightnessEnabledRow.add_suffix(brightnessEnabledLabel);
        brightnessInfoGroup.add(brightnessEnabledRow);

        const monitorBrightnessContainer = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 0,
        });

        const monitorBrightnessRow = new Adw.PreferencesRow({
            child: monitorBrightnessContainer,
        });
        brightnessInfoGroup.add(monitorBrightnessRow);

        const brightnessDetailsExpander = new Adw.ExpanderRow({
            title: 'Brightness Details',
            subtitle: 'Click to expand',
        });
        brightnessInfoGroup.add(brightnessDetailsExpander);

        const brightnessStateRow = new Adw.ActionRow({ title: 'Brightness State' });
        const brightnessStateLabel = new Gtk.Label({ label: 'N/A' });
        brightnessStateRow.add_suffix(brightnessStateLabel);
        brightnessDetailsExpander.add_row(brightnessStateRow);

        const nextTransitionRow = new Adw.ActionRow({ title: 'Next Transition' });
        const nextTransitionLabel = new Gtk.Label({ label: 'N/A' });
        nextTransitionRow.add_suffix(nextTransitionLabel);
        brightnessDetailsExpander.add_row(nextTransitionRow);

        // Manual override controls
        const testGroup = new Adw.PreferencesGroup({ title: 'Manual Override' });
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
            this._updateDebugInfo();
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
            this._updateDebugInfo();
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
            this._updateDebugInfo();
        });
        resetRow.add_suffix(resetButton);
        testGroup.add(resetRow);

        const refreshRow = new Adw.ActionRow({
            title: 'Refresh Status',
            subtitle: 'Update displayed values now',
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

        // Debug logging toggle: routine diagnostics are gated off by default to
        // keep the journal quiet (EGO "No excessive logging"); flip this on when
        // capturing logs for a bug report.
        const debugLoggingRow = new Adw.ActionRow({
            title: 'Debug Logging',
            subtitle: 'Write verbose diagnostics to the system journal',
        });
        const debugLoggingToggle = new Gtk.Switch({
            active: this.settings.get_boolean('debug-logging'),
            valign: Gtk.Align.CENTER,
        });
        this.settings.bind('debug-logging', debugLoggingToggle, 'active', Gio.SettingsBindFlags.DEFAULT);
        debugLoggingRow.add_suffix(debugLoggingToggle);
        debugLoggingRow.activatable_widget = debugLoggingToggle;
        testGroup.add(debugLoggingRow);

        window.add(debugPage);

        // --- About Page ---
        const aboutPage = new Adw.PreferencesPage({
            title: 'About',
            icon_name: 'help-about-symbolic',
        });

        const aboutGroup = new Adw.PreferencesGroup({
            title: 'Automatic Theme Switcher',
            description: 'Automatically switches between light and dark themes based on sunrise/sunset times for your location.',
        });
        aboutPage.add(aboutGroup);

        const versionRow = new Adw.ActionRow({
            title: 'Version',
            subtitle: `${this.metadata.version}`,
        });
        aboutGroup.add(versionRow);

        const authorRow = new Adw.ActionRow({
            title: 'Author',
            subtitle: 'Amritashan S. Lal',
        });
        aboutGroup.add(authorRow);

        // Credits group
        const creditsGroup = new Adw.PreferencesGroup({
            title: 'Credits',
        });
        aboutPage.add(creditsGroup);

        const suncalcRow = new Adw.ActionRow({
            title: 'suncalc Library',
            subtitle: 'Solar calculations by Vladimir Agafonkin (BSD-2-Clause)',
        });
        const suncalcButton = new Gtk.Button({
            label: 'View',
            valign: Gtk.Align.CENTER,
        });
        suncalcButton.connect('clicked', () => {
            Gio.AppInfo.launch_default_for_uri('https://github.com/mourner/suncalc', null);
        });
        suncalcRow.add_suffix(suncalcButton);
        creditsGroup.add(suncalcRow);

        // Support group
        const supportGroup = new Adw.PreferencesGroup({
            title: 'Support This Project',
            description: 'If you find this extension useful, consider supporting its development!',
        });
        aboutPage.add(supportGroup);

        const sponsorRow = new Adw.ActionRow({
            title: 'Sponsor on GitHub',
            subtitle: 'Support with one-time or monthly donations',
        });
        const sponsorButton = new Gtk.Button({
            label: 'Sponsor',
            valign: Gtk.Align.CENTER,
        });
        sponsorButton.add_css_class('suggested-action');
        sponsorButton.connect('clicked', () => {
            Gio.AppInfo.launch_default_for_uri('https://github.com/sponsors/amritashan', null);
        });
        sponsorRow.add_suffix(sponsorButton);
        sponsorRow.set_activatable_widget(sponsorButton);
        supportGroup.add(sponsorRow);

        // Links group
        const linksGroup = new Adw.PreferencesGroup({
            title: 'Links',
        });
        aboutPage.add(linksGroup);

        const githubRow = new Adw.ActionRow({
            title: 'GitHub Repository',
            subtitle: 'View source code and contribute',
        });
        const githubButton = new Gtk.Button({
            label: 'Open',
            valign: Gtk.Align.CENTER,
        });
        githubButton.connect('clicked', () => {
            Gio.AppInfo.launch_default_for_uri('https://github.com/amritashan/gnome-shell-extension-auto-theme-switcher', null);
        });
        githubRow.add_suffix(githubButton);
        githubRow.set_activatable_widget(githubButton);
        linksGroup.add(githubRow);

        const issuesRow = new Adw.ActionRow({
            title: 'Report an Issue',
            subtitle: 'Found a bug? Let us know!',
        });
        const issuesButton = new Gtk.Button({
            label: 'Report',
            valign: Gtk.Align.CENTER,
        });
        issuesButton.connect('clicked', () => {
            Gio.AppInfo.launch_default_for_uri('https://github.com/amritashan/gnome-shell-extension-auto-theme-switcher/issues', null);
        });
        issuesRow.add_suffix(issuesButton);
        issuesRow.set_activatable_widget(issuesButton);
        linksGroup.add(issuesRow);

        window.add(aboutPage);

        // Store labels for updating
        this._debugLabels = {
            currentMode: currentModeLabel,
            currentTime: currentTimeLabel,
            lightTime: lightTimeLabel,
            darkTime: darkTimeLabel,
            nextEvent: nextEventLabel,
            nextEventType: nextEventTypeLabel,
            timeToNext: timeToNextLabel,
            calculationMethod: calculationMethodLabel,
            locationName: debugLocationNameLabel,
            coordinates: coordinatesLabel,
            timezone: timezoneLabel,
            // Today and Tomorrow solar events with their expanders
            todayExpander: todayExpander,
            tomorrowExpander: tomorrowExpander,
            today: todayLabels,
            tomorrow: tomorrowLabels,
            brightnessEnabled: brightnessEnabledLabel,
            brightnessState: brightnessStateLabel,
            nextTransition: nextTransitionLabel,
        };

        this._monitorBrightnessContainer = monitorBrightnessContainer;
        this._nextEventTimestamp = null;

        // Update current time and countdown every second
        this._timeUpdateId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, DEBUG_TIME_UPDATE_INTERVAL_SECONDS, () => {
            const now = new Date();
            currentTimeLabel.set_label(now.toLocaleString());

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

        // Clean up timers when window closes
        window.connect('close-request', () => {
            // Remove timers
            if (this._timeUpdateId) {
                GLib.source_remove(this._timeUpdateId);
                this._timeUpdateId = null;
            }

            if (this._debugRefreshId) {
                GLib.source_remove(this._debugRefreshId);
                this._debugRefreshId = null;
            }

            // Abort any in-flight location request
            if (this._locationSession) {
                this._locationSession.abort();
                this._locationSession = null;
            }

            // Disconnect all settings signals before nulling settings
            if (this._settingsSignalIds && this.settings) {
                for (const signalId of this._settingsSignalIds) {
                    this.settings.disconnect(signalId);
                }
                this._settingsSignalIds = null;
            }

            // Clear references
            this.settings = null;
            this._debugLabels = null;
            this._nextEventTimestamp = null;
            this._monitorBrightnessContainer = null;

            return false;
        });
    }

    _getLocationSubtitle() {
        const lat = this.settings.get_string('manual-latitude');
        const lng = this.settings.get_string('manual-longitude');
        const name = this.settings.get_string('location-name');

        if (lat && lng) {
            return name ? name : `${lat}, ${lng}`;
        }
        return 'Not configured - using custom times';
    }

    _autoDetectLocation(button, spinner, latEntry, lngEntry, autoDetectRow, expander) {
        button.sensitive = false;
        spinner.visible = true;
        spinner.start();

        // Store session for cleanup on window close
        this._locationSession = new Soup.Session();
        const locMessage = Soup.Message.new('GET', 'https://ipinfo.io/loc');

        // Use callback pattern for Soup in prefs.js environment
        this._locationSession.send_and_read_async(
            locMessage,
            GLib.PRIORITY_DEFAULT,
            null,
            (_sess, result) => {
                try {
                    const bytes = this._locationSession.send_and_read_finish(result);
                    const statusCode = locMessage.get_status();

                    if (statusCode === 429) {
                        throw new Error('Rate limit exceeded. Please try again tomorrow or enter coordinates manually.');
                    }

                    if (statusCode !== 200) {
                        throw new Error(`Location service returned error ${statusCode}`);
                    }

                    const locData = new TextDecoder().decode(bytes.get_data()).trim();

                    if (!locData || !locData.includes(',')) {
                        throw new Error('Invalid location data received');
                    }

                    const [latitude, longitude] = locData.split(',');

                    // Step 2: Get location name from OpenStreetMap
                    this._reverseGeocode(this._locationSession, latitude, longitude, (locationName) => {
                        // Update UI
                        latEntry.set_text(latitude);
                        lngEntry.set_text(longitude);

                        // Show detected location in the auto-detect row subtitle
                        autoDetectRow.set_subtitle(locationName);
                        this.settings.set_string('location-name', locationName);

                        // Update expander subtitle
                        expander.set_subtitle(locationName);

                        debugLog(`Prefs: Auto-detected location: ${locationName} (${latitude}, ${longitude})`);

                        spinner.stop();
                        spinner.visible = false;
                        button.sensitive = true;
                    });

                } catch (e) {
                    console.error(`Prefs: Auto-detect location failed: ${e.message}`);
                    this._showLocationError(button, e.message);
                    spinner.stop();
                    spinner.visible = false;
                    button.sensitive = true;
                }
            }
        );
    }

    _reverseGeocode(session, latitude, longitude, callback) {
        const geoUrl = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=10`;
        const geoMessage = Soup.Message.new('GET', geoUrl);
        geoMessage.request_headers.append('User-Agent', 'GNOME-Auto-Theme-Switcher/1.0');

        session.send_and_read_async(
            geoMessage,
            GLib.PRIORITY_DEFAULT,
            null,
            (_sess, result) => {
                let locationName = 'Location detected';
                try {
                    const bytes = session.send_and_read_finish(result);
                    const geoData = JSON.parse(new TextDecoder().decode(bytes.get_data()));

                    if (geoData.address) {
                        const parts = [];
                        if (geoData.address.city) parts.push(geoData.address.city);
                        else if (geoData.address.town) parts.push(geoData.address.town);
                        else if (geoData.address.village) parts.push(geoData.address.village);

                        if (geoData.address.state) parts.push(geoData.address.state);
                        if (geoData.address.country) parts.push(geoData.address.country);

                        locationName = parts.join(', ') || 'Location detected';
                    }
                } catch (geoError) {
                    debugWarn(`Prefs: Reverse geocoding failed: ${geoError.message}`);
                }
                callback(locationName);
            }
        );
    }

    _showLocationError(button, message) {
        const dialog = new Adw.MessageDialog({
            heading: 'Location Detection Failed',
            body: message || 'Unable to detect your location. Please enter coordinates manually.',
            modal: true,
            transient_for: button.get_root(),
        });
        dialog.add_response('ok', 'OK');
        dialog.present();
    }

    _updateMonitorBrightnessList(monitors) {
        if (!this._monitorBrightnessContainer) {
            return;
        }

        let child;
        while ((child = this._monitorBrightnessContainer.get_first_child())) {
            this._monitorBrightnessContainer.remove(child);
        }

        if (!monitors || monitors.length === 0) {
            const noMonitorsLabel = new Gtk.Label({
                label: 'No monitors configured',
                xalign: 0,
                margin_top: 6,
                margin_bottom: 6,
                margin_start: 12,
                margin_end: 12,
            });
            noMonitorsLabel.add_css_class('dim-label');
            this._monitorBrightnessContainer.append(noMonitorsLabel);
            return;
        }

        for (let i = 0; i < monitors.length; i++) {
            const monitor = monitors[i];

            const monitorBox = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 4,
                margin_top: i === 0 ? 6 : 12,
                margin_bottom: i === monitors.length - 1 ? 6 : 0,
                margin_start: 12,
                margin_end: 12,
            });

            const nameLabel = new Gtk.Label({
                label: monitor.name || 'Unknown Monitor',
                xalign: 0,
                wrap: true,
            });
            nameLabel.add_css_class('heading');

            const brightnessText = `Light: ${monitor.lightBrightness || 'N/A'}, Dark: ${monitor.darkBrightness || 'N/A'}, Current: ${monitor.currentBrightness || 'N/A'}`;
            const brightnessLabel = new Gtk.Label({
                label: brightnessText,
                xalign: 0,
                wrap: true,
            });
            brightnessLabel.add_css_class('dim-label');

            monitorBox.append(nameLabel);
            monitorBox.append(brightnessLabel);

            this._monitorBrightnessContainer.append(monitorBox);
        }
    }

    _updateDebugInfo() {
        try {
            const debugInfo = this._getExtensionDebugInfo();
            if (debugInfo && this._debugLabels) {
                this._debugLabels.currentTime.set_label(debugInfo.currentTime || 'N/A');
                this._debugLabels.lightTime.set_label(debugInfo.lightTime || 'N/A');
                this._debugLabels.darkTime.set_label(debugInfo.darkTime || 'N/A');
                this._debugLabels.calculationMethod.set_label(debugInfo.calculationMethod || 'N/A');

                if (debugInfo.manualModeActive) {
                    // Manual override: pause the countdown and replace schedule labels
                    // with explicit indicators. The auto schedule is suspended and the
                    // user has chosen the mode explicitly — showing a stale countdown
                    // would be misleading.
                    const chosen = debugInfo.manualModeIsDark ? 'Dark' : 'Light';
                    this._debugLabels.currentMode.set_label(`${chosen} mode (manual)`);
                    this._debugLabels.nextEvent.set_label('Off until reset');
                    this._debugLabels.nextEventType.set_label('Off until reset');
                    this._debugLabels.timeToNext.set_label('Off until reset');
                    this._nextEventTimestamp = null; // halt the per-second decrement
                } else {
                    this._debugLabels.currentMode.set_label(debugInfo.currentMode || 'N/A');
                    this._debugLabels.nextEvent.set_label(debugInfo.nextEventTime || 'N/A');
                    this._debugLabels.nextEventType.set_label(debugInfo.nextEventType || 'N/A');

                    if (debugInfo.nextEventTimestamp) {
                        // Absolute event time: the per-second countdown ticks
                        // toward it instead of re-anchoring a relative delta
                        // (which froze the countdown at its schedule-time value).
                        this._nextEventTimestamp = debugInfo.nextEventTimestamp;
                    } else if (debugInfo.secondsToNextEvent) {
                        const now = new Date();
                        this._nextEventTimestamp = now.getTime() + (debugInfo.secondsToNextEvent * MS_PER_SECOND);
                    }

                    const seconds = debugInfo.secondsToNextEvent || 0;
                    const hours = Math.floor(seconds / 3600);
                    const minutes = Math.floor((seconds % 3600) / 60);
                    const secs = seconds % 60;
                    this._debugLabels.timeToNext.set_label(`${hours}h ${minutes}m ${secs}s`);
                }

                // Location information
                this._debugLabels.locationName.set_label(debugInfo.locationName || 'Not set');

                if (debugInfo.latitude && debugInfo.longitude &&
                    debugInfo.latitude !== 'Not set' && debugInfo.longitude !== 'Not set') {
                    this._debugLabels.coordinates.set_label(`${debugInfo.latitude}, ${debugInfo.longitude}`);
                } else {
                    this._debugLabels.coordinates.set_label('Not set');
                }

                this._debugLabels.timezone.set_label(debugInfo.timezone || 'N/A');

                // Helper to update solar times for a day
                const updateSolarTimes = (solarData, labels, expander, defaultTitle) => {
                    if (solarData) {
                        // Update expander title with date
                        expander.set_title(`${defaultTitle} — ${solarData.date}`);
                        expander.set_subtitle(`Sunrise: ${solarData.sunrise}, Sunset: ${solarData.sunset}`);

                        // Update all event labels
                        labels.firstLight.set_label(solarData.firstLight || 'N/A');
                        labels.nauticalDawn.set_label(solarData.nauticalDawn || 'N/A');
                        labels.dawn.set_label(solarData.dawn || 'N/A');
                        labels.sunrise.set_label(solarData.sunrise || 'N/A');
                        labels.sunriseEnd.set_label(solarData.sunriseEnd || 'N/A');
                        labels.goldenHourEnd.set_label(solarData.goldenHourEnd || 'N/A');
                        labels.solarNoon.set_label(solarData.solarNoon || 'N/A');
                        labels.goldenHour.set_label(solarData.goldenHour || 'N/A');
                        labels.sunsetStart.set_label(solarData.sunsetStart || 'N/A');
                        labels.sunset.set_label(solarData.sunset || 'N/A');
                        labels.dusk.set_label(solarData.dusk || 'N/A');
                        labels.nauticalDusk.set_label(solarData.nauticalDusk || 'N/A');
                        labels.lastLight.set_label(solarData.lastLight || 'N/A');
                    } else {
                        expander.set_title(defaultTitle);
                        expander.set_subtitle('No coordinates set');
                        const noCoords = 'N/A';
                        Object.values(labels).forEach(label => label.set_label(noCoords));
                    }
                };

                // Update Today's solar times
                updateSolarTimes(
                    debugInfo.solarTimesToday,
                    this._debugLabels.today,
                    this._debugLabels.todayExpander,
                    'Today'
                );

                // Update Tomorrow's solar times
                updateSolarTimes(
                    debugInfo.solarTimesTomorrow,
                    this._debugLabels.tomorrow,
                    this._debugLabels.tomorrowExpander,
                    'Tomorrow'
                );

                // Brightness information
                if (debugInfo.brightness) {
                    this._debugLabels.brightnessEnabled.set_label(
                        debugInfo.brightness.enabled ? 'Enabled' : 'Disabled'
                    );
                    this._debugLabels.brightnessState.set_label(
                        debugInfo.brightness.brightnessState || 'N/A'
                    );
                    this._debugLabels.nextTransition.set_label(
                        debugInfo.brightness.nextTransition || 'N/A'
                    );

                    this._updateMonitorBrightnessList(debugInfo.brightness.monitors || []);
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

    async _checkBrightnessctl() {
        try {
            const path = GLib.find_program_in_path('brightnessctl');
            const result = path !== null;
            debugLog(`Prefs: brightnessctl check result: ${result} (path: ${path})`);
            return result;
        } catch (e) {
            debugLog(`Prefs: brightnessctl check failed: ${e.message}`);
            return false;
        }
    }
}
