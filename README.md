<!-- markdownlint-disable MD033 -->

<h1 align="center">🚀 AG Usage</h1>

<p align="center">
  <strong>Real-time usage tracking for Antigravity AI models</strong>
</p>

<p align="center">
  <a href="https://open-vsx.org/extension/crsx/ag-usage"><img src="https://img.shields.io/open-vsx/v/crsx/ag-usage?logo=open-vsx&logoColor=white" alt="Open VSX Version"></a>
  <a href="https://open-vsx.org/extension/crsx/ag-usage"><img src="https://img.shields.io/open-vsx/dt/crsx/ag-usage" alt="Open VSX Downloads"></a>
  <a href="https://github.com/crsmilitaru97/ag-usage"><img src="https://img.shields.io/badge/GitHub-Repository-181717?logo=github&logoColor=white" alt="GitHub"></a>
  <a href="https://github.com/crsmilitaru97/ag-usage/stargazers"><img src="https://img.shields.io/github/stars/crsmilitaru97/ag-usage" alt="GitHub Stars"></a>
  <a href="https://github.com/crsmilitaru97/ag-usage/blob/main/LICENSE"><img src="https://img.shields.io/github/license/crsmilitaru97/ag-usage" alt="License"></a>
  <a href="https://www.paypal.com/donate?hosted_button_id=MZQS5CZ68NGEW"><img src="https://img.shields.io/badge/Donate-PayPal-00457C?logo=paypal&logoColor=white" alt="Donate"></a>
</p>

---

<p align="center">
  <img src="https://raw.githubusercontent.com/crsmilitaru97/ag-usage/main/example.png" alt="AG Usage Preview" height="300" style="border-radius: 12px; border: 1px solid #30363d; box-shadow: 0 4px 10px rgba(0,0,0,0.25);">
</p>

## ✨ Features

- **Status bar integration**: Displays a status bar item showing the overall average usage percentage of your AI models.

- **Auto-refresh**: Usage data is automatically updated every 60 seconds by default, but can be configured.

- **Detailed tooltip**: Hover over the status bar item to see a detailed breakdown and visual progress bars for model categories (as they are calculated by Antigravity):
  - **Gemini 3 Pro** - Gemini 3 Pro (High) and Gemini 3 Pro (Low)
  - **Gemini 3 Flash** - Gemini 3 Flash
  - **Claude/GPT** - Sonnet 4.5, Sonnet 4.5 (Thinking), Opus 4.5 (Thinking) and GPT-OSS 120B (Medium)

- **Quota reset timer**: Each model category displays the time remaining until quota resets, highlighted in green when less than 10 minutes remains. Time is displayed only when the Antigravity quota reset timer is triggered (first use of the AI model after a 100% usage).

- **Cross-platform**: Fully compatible with **Windows**, **macOS**, and **Linux**.

## 📖 Usage

1. **Install** the extension.
2. Look for the 🚀 icon in the right part of the bottom status bar.
3. **Hover** over the icon to view detailed usage per model category.
4. **Click** the icon to refresh data manually.

## 📝 Configuration

- `ag-usage.refreshInterval`: Set the interval (in seconds) between automatic refreshes. Default is `60` seconds.

- `ag-usage.statusBarDisplay`: Control what information is shown in the status bar. Options:
  - `average` - Shows the average usage across all groups
  - `all` (default) - Shows all three groups side by side (e.g., `Pro: 80% | Flash: 90% | C/G: 50%`)
  - `geminiPro` - Shows only Gemini 3 Pro usage
  - `geminiFlash` - Shows only Gemini 3 Flash usage
  - `claudeGpt` - Shows only Claude/GPT usage

- `ag-usage.statusBarCountdown`: Show time remaining until next reset in the status bar when quota reaches 0%. Default is `true`.

- `ag-usage.showSessionUsageInStatusBar`: Show the estimated usage since session start alongside the quota in the status bar (e.g., `50% (-5%)`). Default is `false`.

- `ag-usage.notifyOnFullQuota`: Show a notification when a model category reaches 100% usage. Default is `false`.

- `ag-usage.lowQuotaNotificationThreshold`: Percentage threshold to show a warning when quota drops below this value. Default is `0` (disabled). Set to a value like `10` to enable.

- `ag-usage.resetTimeDisplay`: How to display the quota reset time. Options: `relative`, `absolute`, `both` (default).

- `ag-usage.absoluteTimeFormat`: Time format for absolute reset time display. Options: `24h` (default), `12h`.

- `ag-usage.trackSessionUsage`: Track session usage (quota used since window opened). Default is `true`.

- `ag-usage.perWindowSession`: When enabled, session usage tracks only quota consumed while this window is focused. Usage from other windows is excluded. Default is `false`.

## ⚙️ Commands

- `ag-usage.refresh`: Manually triggers a scan for the Antigravity process and updates usage statistics.

## 📝 Notes

- Data from server may have a 3-5 minute margin of error. This can result in a "Soon" status or temporary delays in quota synchronization.

- At the moment, it is not possible to retrieve the actual token quota.

## 💡 Inspiration

- This extension was inspired by the [AntigravityQuota](https://github.com/ArataAI/AntigravityQuota) extension, which provides similar functionality.
- Also, inspired by the [progressbar](https://github.com/guibranco/progressbar) idea for creating progress bars in markdown tooltips because VS Code extension API does not support popup menus like the GitHub Copilot one.

---

<p align="center">
  <strong>💖 Support the Development</strong><br><br>
  If you find this extension useful, consider buying me a coffee!<br><br>
  <a href="https://www.paypal.com/donate?hosted_button_id=MZQS5CZ68NGEW">
    <img src="https://www.paypalobjects.com/en_US/i/btn/btn_donateCC_LG.gif" alt="Donate with PayPal" />
  </a>

---

<p align="center">
  <strong>🙏 Thank you for using AG Usage!</strong>
</p>
