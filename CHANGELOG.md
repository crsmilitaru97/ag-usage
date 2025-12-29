# Changelog

## [1.3.1] - 2025-12-29

- Fix: Added process ownership and $HOME validation to ensure correct quota display in multi-user environments (thanks to @costis-t)

## [1.3.0] - 2025-12-29

- Added Open Settings button in the status bar item tooltip
- Refactored code to use classes for better maintainability and stability
- Fixed some connection issues
- Added extension logging (check `Output` > `AG Usage`) for debugging purposes

## [1.2.0] - 2025-12-27

- Fix: Tooltip text was hard to read on light themes
- Added support for customizing the status bar displayed information (`ag-usage.statusBarDisplay`)

## [1.1.0] - 2025-12-26

- Added support for customizing the refresh interval (`ag-usage.refreshInterval`)
- The timer is now visible only when the reset quota time is triggered
- Parallelized port discovery for faster connection

## [1.0.0] - 2025-12-24

- Initial release
