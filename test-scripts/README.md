# Migration Test Scripts (v0 → v1)

This directory contains scripts to help test the migration from the **published version (v0)** to the **new version with external monitors + local solar calculations (v1)**.

## Scripts

### 1. `backup-settings.sh`
**Always run this first!**

Creates a timestamped backup of your current extension settings.

```bash
./backup-settings.sh
```

Backups are saved to `~/.config/auto-theme-switcher-backups/`

---

### 2. `setup-scenario-3.sh`
Sets up test scenario 3: User with default brightness values (light=80%, dark=30%).

```bash
./setup-scenario-3.sh
```

This simulates an existing user who has brightness control enabled with default values.

---

### 3. `setup-scenario-4.sh`
Sets up test scenario 4: User with custom brightness values (light=95%, dark=15%).

```bash
./setup-scenario-4.sh
```

This simulates an existing user who has carefully configured custom brightness settings. **Critical test case** - ensures user's custom values aren't lost!

---

### 4. `verify-migration.sh`
Verifies that migration completed successfully.

```bash
./verify-migration.sh
```

Run this after triggering migration (restart extension or reload GNOME Shell). It checks:
- Old keys were removed
- New `monitors` key exists and is valid
- Builtin monitor was created
- No duplicate monitors
- Brightness values were preserved

---

### 5. `emergency-reset.sh`
Emergency reset to defaults if something goes wrong.

```bash
./emergency-reset.sh
```

⚠️ **Warning:** This will reset ALL extension settings! Use only if migration fails catastrophically.

---

## Testing Workflow - Real Migration Test (Published → Dev)

This is the **recommended workflow** to test migration from a real published extension to your dev version:

### Step 1: Capture Current Dev State (Baseline)

```bash
# Capture what your dev extension looks like now
./capture-old-data.sh > current-dev-state.txt
```

### Step 2: Clean Everything

```bash
# Backup first! (safety)
./backup-settings.sh dev-before-clean

# Clean dev extension completely
./clean-slate.sh
```

### Step 3: Install Published Version

```bash
# Install published extension from extensions.gnome.org
# (Use GNOME Extensions website or command line)

# Verify it's running the old version (no data-version key)
dconf read /org/gnome/shell/extensions/auto-theme-switcher/data-version
# Should output: (empty/error - key doesn't exist)
```

### Step 4: Configure Published Extension

Open preferences and configure:
- Set your location (coordinates)
- Choose light and dark themes
- Enable brightness control
- Set brightness values (light: 80%, dark: 40% for example)
- Configure gradual transitions
- Set trigger times

### Step 5: Capture Old Version State

```bash
# Capture the published version's configuration
./capture-old-data.sh > published-v0-state.txt

# Make a backup too
./backup-settings.sh published-v0
```

### Step 6: Install Dev Extension (Triggers Migration!)

```bash
# Deploy your dev extension
cd ..
./deploy-dev.sh

# This should trigger the v0→v1 migration automatically
```

### Step 7: Verify Migration

```bash
# Run automated verification
./verify-migration.sh

# Capture new state
./capture-old-data.sh > dev-v1-after-migration.txt

# Compare states
diff published-v0-state.txt dev-v1-after-migration.txt
```

### Step 8: Watch Logs During Migration

```bash
# In a separate terminal, watch the migration happen
journalctl -f /usr/bin/gnome-shell | grep -i "Migration"

# Look for:
# - "Current data version: 0"
# - "Running migration v0 → v1"
# - "Found old light-brightness: XX%"
# - "Builtin monitor created"
# - "Removed old API key: ..."
# - "Migration v0→v1 complete"
```

---

## Quick Test (Using Setup Scripts)

If you want to quickly test migration logic without installing published version:

### Scenario 3 (Default Values)

```bash
./backup-settings.sh
./setup-scenario-3.sh
gnome-extensions disable auto-theme-switcher@amritashan.github.io
gnome-extensions enable auto-theme-switcher@amritashan.github.io
./verify-migration.sh
```

### Scenario 4 (Custom Values)

```bash
./backup-settings.sh
./setup-scenario-4.sh
gnome-extensions disable auto-theme-switcher@amritashan.github.io
gnome-extensions enable auto-theme-switcher@amritashan.github.io
./verify-migration.sh
```

---

## Manual Verification Steps

After running `verify-migration.sh`, also check:

1. **Open Preferences UI**
   ```bash
   gnome-extensions prefs auto-theme-switcher@amritashan.github.io
   ```
   - Should open without crashes
   - Check if settings display correctly

2. **Test Brightness Control**
   - Enable brightness control
   - Adjust sliders
   - Verify preview works
   - Verify brightness actually changes

3. **Check Logs**
   ```bash
   journalctl -b | grep DisplayManager
   ```
   - Look for migration messages
   - Check for any errors
   - Verify brightness values logged match expectations

4. **Test Gradual Transitions**
   - Set light/dark times close to current time
   - Wait for transition to start
   - Verify brightness changes gradually
   - No sudden jumps

---

## Restoring from Backup

If you need to restore your settings:

```bash
# List available backups
ls -lh ~/.config/auto-theme-switcher-backups/

# Restore from a specific backup
dconf load /org/gnome/shell/extensions/auto-theme-switcher/ < ~/.config/auto-theme-switcher-backups/settings-backup-TIMESTAMP.dconf

# Restart extension
gnome-extensions disable auto-theme-switcher@amritashan.github.io
gnome-extensions enable auto-theme-switcher@amritashan.github.io
```

---

## Troubleshooting

### Migration doesn't run
- Check that `monitors` key is empty: `dconf read /org/gnome/shell/extensions/auto-theme-switcher/monitors`
- If it contains `[]` or has monitors, reset it: `dconf write /org/gnome/shell/extensions/auto-theme-switcher/monitors "'[]'"`
- Clear the builtin monitor and restart extension

### Old values not preserved
- **This is the bug we're testing for!**
- Check if old keys still exist: `dconf read /org/gnome/shell/extensions/auto-theme-switcher/light-brightness`
- If they exist but weren't migrated, the migration code needs fixing
- See MIGRATION_TEST_PLAN.md for the fix

### Extension crashes
- Check logs: `journalctl -b | grep -i "auto-theme-switcher\|DisplayManager"`
- Look for JavaScript errors
- Try emergency reset: `./emergency-reset.sh`

### Brightness jumps unexpectedly
- This means migration read current brightness instead of configured values
- Check what the migration saved: `dconf read /org/gnome/shell/extensions/auto-theme-switcher/monitors | jq '.[] | select(.id == "builtin")'`
- Compare to expected values from scenario setup

---

## What Gets Migrated (v0 → v1)

### Keys Removed:
- `light-brightness` → migrated to `monitors` array
- `dark-brightness` → migrated to `monitors` array
- `auto-detect-location` → removed (API-based, no longer used)
- `use-manual-coordinates` → removed (no longer needed)
- `api-cache` → removed (local solar calculations now)
- `last-api-error` → removed
- `last-api-error-time` → removed

### Keys Added:
- `data-version` = 1
- `monitors` = array with builtin monitor
- `location-name` = initialized if coordinates exist
- `monitors-last-detection` = timestamp
- `true-light-mode` = false (new feature)
- `last-session-id` = '' (new feature)

### Keys Preserved:
- `manual-latitude` / `manual-longitude`
- `light-theme` / `dark-theme`
- `control-brightness`
- `show-notifications`
- All trigger settings
- All night-light settings
- All gradual transition settings

---

## Expected Migration Log Output

```
MigrationManager: Current data version: 0
MigrationManager: Running migration v0 → v1 (external monitors + local solar)
MigrationManager: Starting migration v0 → v1
MigrationManager: Found old light-brightness: 80%
MigrationManager: Found old dark-brightness: 40%
MigrationManager: Builtin monitor created - light=80%, dark=40%
MigrationManager: Cleaned up old brightness keys
MigrationManager: Removed old API key: auto-detect-location
MigrationManager: Removed old API key: use-manual-coordinates
MigrationManager: Removed old API key: api-cache
MigrationManager: Removed old API key: last-api-error
MigrationManager: Removed old API key: last-api-error-time
MigrationManager: Set default location name for existing coordinates
MigrationManager: Migration v0→v1 complete - 1 total monitors
MigrationManager: All migrations complete
```
