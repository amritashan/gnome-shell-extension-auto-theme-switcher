# Automatic Theme Switcher for GNOME Shell

Automatically switch between light and dark themes based on sunrise/sunset times for your location.

## Features

- **Location-based switching**: Detects your location via IP and fetches accurate sunrise/sunset times
- **Multiple trigger options**:
  - **Light Mode**: First Light, Dawn, Sunrise, or Custom Time
  - **Dark Mode**: Golden Hour, Dusk, Last Light, or Custom Time
- **Night Light sync**: Optionally enable/disable Night Light with theme changes
- **Suspend/Resume handling**: Correctly switches themes when waking from suspend
- **Debug panel**: Real-time information showing current mode, trigger times, and countdown to next switch
- **Manual testing**: Preview light/dark themes before automatic switching

## Installation

### From GNOME Extensions Website (Recommended)
Visit [extensions.gnome.org](https://extensions.gnome.org/) and search for "Automatic Theme Switcher"

### Manual Installation
1. Download the latest release
2. Extract to `~/.local/share/gnome-shell/extensions/auto-theme-switcher@amritashan.github.io/`
3. Restart GNOME Shell (Alt+F2, type 'r', press Enter on X11)
4. Enable the extension: `gnome-extensions enable auto-theme-switcher@amritashan.github.io`

## Usage

1. Open the extension settings from GNOME Extensions app
2. Configure your preferred themes for light and dark modes
3. Choose when to switch to light mode (First Light, Dawn, Sunrise, or Custom)
4. Choose when to switch to dark mode (Golden Hour, Dusk, Last Light, or Custom)
5. Optionally enable Night Light syncing
6. Check the Debug tab to see real-time information

## Requirements

- GNOME Shell 45, 46, or 47
- Internet connection (for location detection and sun time calculation)

## How It Works

1. Detects your location using IP geolocation
2. Fetches sunrise/sunset/golden hour times from sunrisesunset.io API
3. Gets location name via OpenStreetMap Nominatim
4. Automatically switches themes at configured times
5. Handles system suspend/resume to catch up on missed switches

## Privacy

- Location is detected via IP address (ipinfo.io)
- Sun times are fetched from api.sunrisesunset.io
- Location names from OpenStreetMap Nominatim
- No personal data is stored or transmitted beyond these API calls

## Development

### Project Structure

```
src/                    # Source files
  ├── extension.js      # Extension entry point (minimal)
  ├── extensionController.js  # Main extension logic
  ├── apiClient.js      # API client for fetching sun times
  ├── themeController.js      # Theme switching logic
  ├── brightnessController.js # Brightness control logic
  ├── timeCalculator.js       # Time calculation utilities
  ├── prefs.js          # Preferences UI
  ├── metadata.json     # Extension metadata
  └── schemas/          # GSettings schemas

build/                  # Build output (generated)
  └── ...               # All files from src/ copied here
```

### Development Workflow

**For local development/testing:**
```bash
./deploy.sh
```
This script:
- Copies all files directly from `src/` to the installation directory
- Compiles schemas
- Reloads the extension automatically
- Works on both X11 and Wayland

**For packaging (e.g., for extensions.gnome.org):**
```bash
./package.sh          # Build and create zip package
# or
./package.sh build    # Only build (copy src/ to build/)
```

The build process automatically copies **all files** from `src/` to `build/`, so you never need to manually specify which files to copy. When you add new files to `src/`, they'll automatically be included in the next build.

### Making Changes

1. Edit files in `src/` directory
2. Run `./deploy.sh` to test locally
3. Test the changes
4. When ready to package: `./package.sh`

## Contributing

Contributions are welcome! Please open an issue or submit a pull request on GitHub.

## License

This extension is released under the GPL-3.0 license.

## Credits

- Sun time data: [Sunrise Sunset API](https://sunrisesunset.io/)
- Location data: [IPinfo.io](https://ipinfo.io/) and [OpenStreetMap Nominatim](https://nominatim.openstreetmap.org/)
