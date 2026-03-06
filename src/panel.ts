import * as vscode from 'vscode';
import { CATEGORY_ORDER, CONFIG_NAMESPACE } from './constants';
import { formatFullTimestamp, formatRelativeTime } from './formatter';
import { QuotaHistory, QuotaHistoryEntry } from './history';
import { QuotaGroup, UsageStatistics } from './types';

export class UsageViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'ag-usage.sidebarPanel';
	private view?: vscode.WebviewView;
	private lastStatsData: UsageStatistics | null = null;
	private quotaHistory: QuotaHistory | null = null;
	private disposables: vscode.Disposable[] = [];


	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken
	) {
		this.view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
		};

		webviewView.onDidDispose(() => {
			this.view = undefined;
		}, null, this.disposables);

		webviewView.webview.onDidReceiveMessage((message) => {
			if (message.command === 'clearHistory') {
				if (this.quotaHistory) {
					this.quotaHistory.clearCategory(message.category);
					this.updateView();
				}
			}
		}, null, this.disposables);

		this.updateView();
	}

	public update(statsData: UsageStatistics | null, history: QuotaHistory) {
		this.lastStatsData = statsData;
		this.quotaHistory = history;
		if (this.view) {
			this.updateView();
		}
	}

	private updateView() {
		if (!this.view || !this.quotaHistory) { return; }
		const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
		const localeSetting = config.get<string>('dateFormatLocale', 'default');
		const locale = localeSetting === 'default' ? undefined : localeSetting;
		this.view.webview.html = buildPanelHtml(this.lastStatsData, this.quotaHistory, locale);
	}

	dispose() {
		this.disposables.forEach(d => d.dispose());
		this.disposables = [];
	}
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatPercent(fraction: number): string {
	return `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
}

function formatResetTime(resetTime: number | null, locale?: string): string {
	if (resetTime === null) { return '—'; }
	return formatFullTimestamp(resetTime, locale);
}

function getBarColorClass(fraction: number): string {
	const pct = fraction * 100;
	if (pct >= 65) { return 'bar-success'; }
	if (pct >= 25) { return 'bar-warning'; }
	return 'bar-error';
}

function getDeltaClass(delta: number): string {
	if (delta > 0) { return 'delta-positive'; }
	if (delta < 0) { return 'delta-negative'; }
	return '';
}

function formatDelta(delta: number): string {
	const pct = Math.round(delta * 100);
	return pct > 0 ? `+${pct}%` : `${pct}%`;
}

function buildHistoryItemHtml(entry: QuotaHistoryEntry, previousEntry?: QuotaHistoryEntry, locale?: string): string {
	const deltaClass = getDeltaClass(entry.delta);
	let detailsHtml: string;
	if (entry.isInitial) {
		detailsHtml = `<div class="history-item-change">
				<span class="cell-value">Started at ${escapeHtml(formatPercent(entry.currentQuota))}</span>
			</div>`;
	} else if (entry.currentQuota >= 1 && entry.previousQuota < 1) {
		detailsHtml = `<div class="history-item-change">
				<span class="cell-delta delta-positive">✓ Fully restored</span>
			</div>`;
	} else {
		detailsHtml = `<div class="history-item-change">
				<span class="cell-value">${escapeHtml(formatPercent(entry.previousQuota))} → ${escapeHtml(formatPercent(entry.currentQuota))}</span>
				<span class="cell-delta ${deltaClass}">${escapeHtml(formatDelta(entry.delta))}</span>
			</div>`;
	}

	let resetText = formatResetTime(entry.resetTime, locale);
	if (entry.resetTime !== null && entry.resetTime > entry.timestamp) {
		const diffMs = entry.resetTime - entry.timestamp;
		const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
		const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
		
		let diffStr = '';
		if (days > 0 && hours > 0) {
			diffStr = `${days} day${days > 1 ? 's' : ''} and ${hours} hour${hours > 1 ? 's' : ''}`;
		} else if (days > 0) {
			diffStr = `${days} day${days > 1 ? 's' : ''}`;
		} else if (hours > 0) {
			diffStr = `${hours} hour${hours > 1 ? 's' : ''}`;
		} else {
			diffStr = '<1 hour';
		}
		
		resetText += ` (in ${diffStr})`;
	}

	const tsDate = new Date(entry.timestamp);
	const dateStr = new Intl.DateTimeFormat(locale, { month: '2-digit', day: '2-digit' }).format(tsDate);
	const timeStr = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: false }).format(tsDate);

	let lapseHtml = '';
	if (previousEntry !== undefined) {
		const diffMs = Math.max(0, entry.timestamp - previousEntry.timestamp);
		lapseHtml = `<div class="history-lapsed">↑ ${escapeHtml(formatRelativeTime(diffMs))}</div>`;
	}

	return `
		<div class="history-row">
			<div class="history-date">
				<span class="history-date-day">${escapeHtml(dateStr)}</span>
				<span class="history-date-time">${escapeHtml(timeStr)}</span>
				${lapseHtml}
			</div>
			<div class="history-content">
				${detailsHtml}
				<div class="cell-reset">Reset: ${escapeHtml(resetText)}</div>
			</div>
		</div>`;
}

function buildHistorySectionHtml(category: string, categoryEntries: QuotaHistoryEntry[], locale?: string): string {
	if (categoryEntries.length === 0) { return ''; }

	return `
		<details class="card-history-details">
			<summary class="card-history-summary">
				<span style="display: flex; align-items: center; gap: 6px;">History (${categoryEntries.length})</span>
				<span class="clear-history-icon" data-category="${escapeHtml(category)}" title="Clear History" onclick="clearCatHistory(event, this)">
					<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M10 3h3v1h-1v9l-1 1H4l-1-1V4H2V3h3V2a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1zM6 2v1h3V2H6zm4 11V4H5v9h5z" /></svg>
				</span>
			</summary>
			<div class="history-list">
				${categoryEntries.map((entry, index) => {
		const previousEntry = categoryEntries[index + 1];
		return buildHistoryItemHtml(entry, previousEntry, locale);
	}).join('')}
			</div>
		</details>`;
}

function buildCardHeaderHtml(category: string, group: QuotaGroup | undefined, locale?: string): string {
	if (!group) {
		return `
			<div class="quota-card-header">
				<div class="quota-card-title">
					<span class="quota-label">${escapeHtml(category)}</span>
				</div>
				<div class="quota-value">—</div>
			</div>`;
	}

	const pct = Math.round(Math.max(0, Math.min(1, group.quota)) * 100);
	const colorClass = getBarColorClass(group.quota);
	let resetValueHtml = 'Not started';
	if (group.resetTime) {
		resetValueHtml = escapeHtml(formatFullTimestamp(group.resetTime, locale));
		const diffMs = group.resetTime - Date.now();
		if (diffMs > 0) {
			resetValueHtml += ` <span class="reset-interval">(${escapeHtml(formatRelativeTime(diffMs))})</span>`;
		}
	}

	return `
		<div class="quota-card-header">
			<div class="quota-card-title">
				<span class="quota-label">${escapeHtml(category)}</span>
			</div>
			<div class="quota-value ${colorClass}">${pct}%</div>
		</div>
		<div class="quota-bar-track">
			${Array.from({ length: 5 }).map((_, i) => {
		const startPct = i * 20;
		const fillPct = Math.max(0, Math.min(100, (pct - startPct) * 5));
		return `<div class="quota-bar-segment-bg"><div class="quota-bar-segment-fill ${colorClass} w-${fillPct}"></div></div>`;
	}).join('')}
		</div>
		<div class="quota-reset">
			<span class="reset-label">Resets at</span>
			<span class="reset-value">${resetValueHtml}</span>
		</div>`;
}

function buildQuotaCards(statsData: UsageStatistics | null, history: QuotaHistory, locale?: string): string {
	const groups = statsData?.groups || {};
	const entries = history.getEntries();

	const grouped = new Map<string, QuotaHistoryEntry[]>();
	for (const entry of entries) {
		const catEntries = grouped.get(entry.category) || [];
		catEntries.push(entry);
		grouped.set(entry.category, catEntries);
	}

	const categories: string[] = CATEGORY_ORDER.filter(c => groups[c] || grouped.has(c));
	for (const cat of Object.keys(groups)) {
		if (!categories.includes(cat)) { categories.push(cat); }
	}
	for (const cat of grouped.keys()) {
		if (!categories.includes(cat)) { categories.push(cat); }
	}

	if (categories.length === 0) {
		if (!statsData) { return '<div class="empty-state">Waiting for data…</div>'; }
		return '<div class="empty-state">No quota data available</div>';
	}

	return categories.map(category => {
		const group = groups[category];
		const categoryEntries = (grouped.get(category) || []).slice().reverse();

		const headerHtml = buildCardHeaderHtml(category, group, locale);
		const historyHtml = buildHistorySectionHtml(category, categoryEntries, locale);

		return `
			<div class="quota-card">
				${headerHtml}
				${historyHtml}
			</div>`;
	}).join('');
}

const WIDTH_CLASSES = Array.from({ length: 101 }, (_, i) => `.w-${i} { width: ${i}%; }`).join('\n');

function getPanelStyles(): string {
	return `
:root {
	--panel-bg: var(--vscode-editor-background);
	--card-bg: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
	--card-border: var(--vscode-editorWidget-border, var(--vscode-panel-border));
	--text-primary: var(--vscode-foreground);
	--text-secondary: var(--vscode-descriptionForeground);
	--text-muted: var(--vscode-disabledForeground);
	--accent: var(--vscode-focusBorder);
	--bar-track: var(--vscode-progressBar-background);
	--table-header-bg: var(--vscode-editorGroupHeader-tabsBackground);
	--table-row-hover: var(--vscode-list-hoverBackground);
	--table-border: var(--vscode-editorGroup-border, var(--vscode-panel-border));
	--badge-bg: var(--vscode-badge-background);
	--badge-fg: var(--vscode-badge-foreground);
	--success: #10b981;
	--warning: #f59e0b;
	--error: #ef4444;
	--radius-sm: 6px;
	--radius-md: 10px;
	--radius-lg: 14px;
}

* {
	margin: 0;
	padding: 0;
	box-sizing: border-box;
	scrollbar-width: thin;
	scrollbar-color: var(--vscode-scrollbarSlider-background) transparent;
}

*::-webkit-scrollbar {
	width: 6px;
	height: 6px;
}
*::-webkit-scrollbar-track {
	background: transparent;
}
*::-webkit-scrollbar-thumb {
	background: var(--vscode-scrollbarSlider-background);
	border-radius: 3px;
}
*::-webkit-scrollbar-thumb:hover {
	background: var(--vscode-scrollbarSlider-hoverBackground);
}
*::-webkit-scrollbar-thumb:active {
	background: var(--vscode-scrollbarSlider-activeBackground);
}

body {
	background: var(--panel-bg);
	color: var(--text-primary);
	font-family: var(--vscode-font-family);
	font-size: var(--vscode-font-size);
	line-height: 1.5;
	padding: 16px 12px;
	height: 100vh;
	display: flex;
	flex-direction: column;
	overflow: hidden;
	user-select: none;
}

.section {
	margin-bottom: 24px;
}

.plan-section {
	margin-bottom: 16px;
}

.section.flex-grow {
	flex: 1;
	margin-bottom: 0;
	min-height: 0;
	display: flex;
	flex-direction: column;
}

.section-title {
	font-size: 13px;
	font-weight: 600;
	text-transform: uppercase;
	letter-spacing: 0.8px;
	color: var(--text-secondary);
	margin-bottom: 14px;
	display: flex;
	align-items: center;
	gap: 8px;
}

.section-title::after {
	content: '';
	flex: 1;
	height: 1px;
	background: var(--table-border);
}

.quota-grid {
	display: flex;
	flex-direction: column;
	gap: 12px;
	flex: 1;
	min-height: 0;
	overflow-y: auto;
}

.quota-card {
	background: var(--card-bg);
	border: 1px solid var(--card-border);
	border-radius: var(--radius-lg);
	padding: 16px;
	flex-shrink: 0;
}

.plan-card {
	padding: 12px 16px;
}

.quota-card-header {
	display: flex;
	justify-content: space-between;
	align-items: center;
	margin-bottom: 12px;
}

.quota-card-title {
	display: flex;
	align-items: center;
	gap: 8px;
}

.quota-label {
	font-size: 12px;
	font-weight: 600;
	text-transform: uppercase;
	letter-spacing: 0.6px;
	color: var(--text-secondary);
}

.quota-value {
	font-size: 20px;
	font-weight: 700;
	letter-spacing: -0.5px;
}

.plan-value {
	font-size: 13px;
	font-weight: 600;
	letter-spacing: 0.5px;
	color: var(--text-primary);
	text-transform: uppercase;
}

.plan-header {
	margin-bottom: 0;
}

.button {
	display: inline-block;
	padding: 4px 8px;
	background: var(--vscode-button-background);
	color: var(--vscode-button-foreground);
	border: none;
	border-radius: var(--radius-sm);
	text-decoration: none;
	font-size: 11px;
	font-weight: 600;
	cursor: pointer;
	text-transform: uppercase;
}

.button:hover {
	background: var(--vscode-button-hoverBackground);
}

.quota-value.bar-success { color: var(--success); }
.quota-value.bar-warning { color: var(--warning); }
.quota-value.bar-error { color: var(--error); }

.quota-bar-track {
	display: flex;
	gap: 2px;
	height: 6px;
	margin-bottom: 14px;
}

.quota-bar-segment-bg {
	flex: 1;
	background: var(--table-border);
	border-radius: 3px;
	overflow: hidden;
}

.quota-bar-segment-fill {
	height: 100%;
	border-radius: 3px;
	transition: width 0.3s ease;
}

.quota-bar-segment-fill.bar-success { background: var(--success); }
.quota-bar-segment-fill.bar-warning { background: var(--warning); }
.quota-bar-segment-fill.bar-error { background: var(--error); }

.quota-reset {
	display: flex;
	justify-content: space-between;
	align-items: center;
}

.reset-label {
	font-size: 11px;
	color: var(--text-muted);
}

.reset-value {
	font-size: 11px;
	color: var(--text-secondary);
	font-variant-numeric: tabular-nums;
}

.reset-interval {
	color: var(--text-muted);
	opacity: 0.8;
}

.history-list {
	display: flex;
	flex-direction: column;
	gap: 4px;
	margin-top: 8px;
	padding-right: 4px;
	max-height: 300px;
	overflow-y: auto;
	overflow-x: hidden;
}

.card-history-details {
	margin-top: 14px;
	border-top: 1px solid var(--table-border);
}

.card-history-summary {
	cursor: pointer;
	user-select: none;
	font-size: 11px;
	font-weight: 600;
	text-transform: uppercase;
	color: var(--text-secondary);
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 6px;
	list-style: none;
	flex-shrink: 0;
	padding-top: 12px;
	padding-bottom: 4px;
	position: sticky;
	top: 0;
	background: var(--card-bg);
	z-index: 10;
}

.card-history-summary::-webkit-details-marker {
	display: none;
}

.card-history-summary::before {
	content: '▶';
	font-size: 8px;
	transition: transform 0.2s;
}

.card-history-details[open] .card-history-summary::before {
	transform: rotate(90deg);
}

.card-history-details[open] .history-list {
	animation: slideDown 0.2s ease-out forwards;
}

@keyframes slideDown {
	0% { opacity: 0; transform: translateY(-4px); }
	100% { opacity: 1; transform: translateY(0); }
}

.clear-history-icon {
	opacity: 0.6;
	cursor: pointer;
	padding: 2px;
	border-radius: 4px;
	display: flex;
	align-items: center;
}

.clear-history-icon:hover {
	opacity: 1;
	background: var(--table-row-hover);
	color: var(--error);
}

.history-row {
	display: flex;
	background: var(--card-bg);
	border: 1px solid var(--card-border);
	border-radius: var(--radius-sm);
	overflow: hidden;
	flex-shrink: 0;
}

.history-date {
	padding: 6px 10px;
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: 1px;
	border-right: 1px solid var(--card-border);
	width: 65px;
	flex-shrink: 0;
}

.history-date-day {
	font-size: 11px;
	font-weight: 600;
	color: var(--text-secondary);
	font-variant-numeric: tabular-nums;
}

.history-date-time {
	font-size: 10px;
	color: var(--text-muted);
	font-variant-numeric: tabular-nums;
}

.history-lapsed {
	font-size: 9px;
	color: var(--text-muted);
	margin-top: 2px;
	opacity: 0.7;
}

.history-content {
	padding: 6px 10px;
	display: flex;
	flex-direction: column;
	justify-content: center;
	gap: 2px;
	flex: 1;
	min-width: 0;
}

.history-item-change {
	display: flex;
	gap: 6px;
	align-items: center;
}

.cell-model {
	display: flex;
	align-items: center;
	gap: 6px;
	font-weight: 500;
}

.cell-value {
	color: var(--text-secondary);
	font-size: 12px;
}

.cell-delta {
	font-weight: 600;
	font-size: 11px;
}

.delta-positive { color: var(--success); }
.delta-negative { color: var(--error); }

.cell-reset {
	color: var(--text-muted);
	font-size: 10px;
}

.empty-state,
.empty-cell {
	text-align: center;
	color: var(--text-muted);
	padding: 32px 16px;
	font-style: italic;
}

.panel-footer {
	padding: 8px 0 0;
	font-size: 10px;
	color: var(--text-muted);
	text-align: center;
	flex-shrink: 0;
}

${WIDTH_CLASSES}
`;
}

function buildPanelHtml(statsData: UsageStatistics | null, history: QuotaHistory, locale?: string): string {
	let planSection = '';
	if (statsData) {
		const planDisplay = statsData.planName ?? statsData.plan ?? '';
		if (planDisplay) {
			planSection = `
	<div class="section plan-section">
		<div class="quota-grid">
			<div class="quota-card plan-card">
				<div class="quota-card-header plan-header">
					<div class="plan-value">${escapeHtml(planDisplay)}</div>
					<a class="button" href="https://antigravity.google/docs/plans">Plans info</a>
				</div>
			</div>
		</div>
	</div>`;
		}
	}
	const quotaCards = buildQuotaCards(statsData, history, locale);

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
${getPanelStyles()}
</style>
</head>
<body>
	${planSection}
	<div class="section flex-grow">
		<div class="quota-grid">${quotaCards}</div>
	</div>
	<div class="panel-footer" id="lastUpdated">Updated just now</div>
<script>
const vscode = acquireVsCodeApi();
const updatedAt = ${Date.now()};
function updateFooter() {
	const diff = Date.now() - updatedAt;
	const sec = Math.floor(diff / 1000);
	const el = document.getElementById('lastUpdated');
	if (!el) return;
	if (sec < 10) el.textContent = 'Updated just now';
	else if (sec < 60) el.textContent = 'Updated ' + sec + 's ago';
	else {
		const min = Math.floor(sec / 60);
		el.textContent = 'Updated ' + min + 'm ago';
	}
}
setInterval(updateFooter, 10000);

function clearCatHistory(event, el) {
	event.preventDefault();
	event.stopPropagation();
	vscode.postMessage({
		command: 'clearHistory',
		category: el.getAttribute('data-category')
	});
}

document.querySelectorAll('.card-history-details').forEach(details => {
	details.addEventListener('toggle', () => {
		if (details.open) {
			document.querySelectorAll('.card-history-details').forEach(other => {
				if (other !== details) other.open = false;
			});
		}
	});
});
</script>
</body>
</html>`;
}
