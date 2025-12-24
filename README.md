# 🚀 AG Usage - Antigravity models usage indicator

**AG Usage** is a Google Antigravity IDE extension designed to monitor the usage quotas of Antigravity AI models in real-time. It connects locally to the running Antigravity language server to retrieve and visualize your current consumption metrics.

![UI Example](https://raw.githubusercontent.com/crsmilitaru97/ag-usage/main/example.png)

## ✨ Features

- **Status bar integration**: Displays a status bar item showing the overall average usage percentage of your AI models.

- **Auto-refresh**: Usage data is automatically updated every 60 seconds.

- **Detailed tooltip**: Hover over the status bar item to see a detailed breakdown and visual progress bars for model categories (as they are calculated by Antigravity):
  - **Gemini 3 Pro** - Gemini 3 Pro (High) and Gemini 3 Pro (Low)
  - **Gemini 3 Flash** - Gemini 3 Flash
  - **Claude/GPT** - Claude Sonnet 4.5, Claude 4.5 (Thinking), Claude Opus 4.5 (Thinking) and GPT-OSS 120B (Medium)

- **Quota reset timer**: Each model category displays the time remaining until quota resets, highlighted in green when less than 1 hour remains.

- **Cross-platform**: Fully compatible with **Windows**, **macOS**, and **Linux**.

- **Lightweight**: Ultra‑compact (<30 KB), minimal performance impact using cached connection, and a clean, modern interface.

## 📖 Usage

1. **Install** the extension.
2. Look for the 🚀 icon in the right part of the bottom status bar.
3. **Hover** over the icon to view detailed usage per model category.
4. **Click** the icon to refresh data manually.

## ⚙️ Commands

- `ag-usage.refresh`: Manually triggers a scan for the Antigravity process and updates usage statistics.

## 💡 Inspiration

- This extension was inspired by the [AntigravityQuota](https://github.com/ArataAI/AntigravityQuota) extension, which provides similar functionality.
- Also, inspired by the [progressbar](https://github.com/guibranco/progressbar) idea for creating progress bars in markdown tooltips because VS Code extension API does not support popup menus like the GitHub Copilot one.
