import * as vscode from 'vscode';
import { extractCsrfToken, fetchStats, findAntigravityProcess, findListeningPorts, findValidPort } from './api';
import {
	CACHE_TTL_MS,
	CATEGORY_ORDER,
	CONFIG_NAMESPACE,
	DEFAULT_REFRESH_INTERVAL,
	EXTENSION_TITLE,
	FAILED_REFRESH_DELAY_MS,
	INITIAL_DELAY_MS,
	MAX_FAILED_REFRESH_DELAY_MS,
	MIN_DISPLAY_DELAY_MS,
	MS_PER_SECOND,
	REFRESH_COMMAND,
	RESET_SESSION_COMMAND,
	SETTINGS_COMMAND,
	STATUS_BAR_PRIORITY,
	USE_MOCK_DATA
} from './constants';
import { createErrorTooltip } from './formatter';
import { renderStats } from './renderer';
import { CachedConnection, SessionQuotaTracker, UsageStatistics } from './types';
import { getErrorMessage } from './utils';

async function loadMockUsageStatistics(): Promise<UsageStatistics> {
	const testDataModule = await import('../dev/testData.json', { with: { type: 'json' } });
	const testData = testDataModule.default;
	const now = Date.now();
	const groups: Record<string, { quota: number; resetTime: number | null }> = {};
	for (const [name, data] of Object.entries(testData.usageStatistics.groups)) {
		groups[name] = {
			quota: data.quota,
			resetTime: data.resetTimeOffsetMs ? now + data.resetTimeOffsetMs : null
		};
	}
	return { groups, plan: testData.usageStatistics.plan };
}

class ExtensionState implements vscode.Disposable {
	private readonly outputChannel: vscode.OutputChannel;
	statusBarItem!: vscode.StatusBarItem;
	refreshTimer?: ReturnType<typeof setTimeout>;
	initialRefreshTimeout?: ReturnType<typeof setTimeout>;
	cachedConnection: CachedConnection | null = null;
	lastStatsData: UsageStatistics | null = null;
	refreshPromise: Promise<void> | null = null;
	lastRefreshSucceeded = false;
	consecutiveFailures = 0;
	isActive = false;
	fullQuotaNotifiedCategories = new Set<string>();
	lowQuotaNotifiedCategories = new Set<string>();
	sessionTracker: SessionQuotaTracker | null = null;

	constructor(context: vscode.ExtensionContext) {
		this.outputChannel = vscode.window.createOutputChannel(EXTENSION_TITLE);

		this.isActive = true;

		context.subscriptions.push(this.outputChannel);
		this.recreateStatusBarItem();
	}

	recreateStatusBarItem() {
		const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
		const alignment = config.get<string>('statusBarAlignment') === 'Left'
			? vscode.StatusBarAlignment.Left
			: vscode.StatusBarAlignment.Right;
		const priority = config.get<number>('statusBarPriority', STATUS_BAR_PRIORITY);

		if (this.statusBarItem) {
			const oldItem = this.statusBarItem;
			this.statusBarItem = vscode.window.createStatusBarItem(alignment, priority);
			this.statusBarItem.command = oldItem.command;
			this.statusBarItem.text = oldItem.text;
			this.statusBarItem.tooltip = oldItem.tooltip;
			this.statusBarItem.color = oldItem.color;
			this.statusBarItem.backgroundColor = oldItem.backgroundColor;
			oldItem.dispose();
		} else {
			this.statusBarItem = vscode.window.createStatusBarItem(alignment, priority);
			this.statusBarItem.command = REFRESH_COMMAND;
			this.statusBarItem.text = `$(rocket) ${EXTENSION_TITLE}`;
		}

		this.statusBarItem.show();
	}

	dispose() {
		this.statusBarItem?.dispose();
		this.isActive = false;
		this.clearTimers();
		this.cachedConnection = null;
		this.lastStatsData = null;
		this.refreshPromise = null;
		this.lastRefreshSucceeded = false;
		this.consecutiveFailures = 0;
		this.fullQuotaNotifiedCategories.clear();
		this.lowQuotaNotifiedCategories.clear();
		this.sessionTracker = null;
	}

	clearTimers() {
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = undefined;
		}
		if (this.initialRefreshTimeout) {
			clearTimeout(this.initialRefreshTimeout);
			this.initialRefreshTimeout = undefined;
		}
	}

	log(message: string, error?: unknown) {
		if (!this.isActive) { return; }
		const timestamp = new Date().toISOString();
		const logMessage = error
			? `[${timestamp}] ${message}: ${getErrorMessage(error)}`
			: `[${timestamp}] ${message}`;
		this.outputChannel.appendLine(logMessage);
	}
}

let state: ExtensionState | undefined;

export function activate(context: vscode.ExtensionContext) {
	if (!vscode.env.appName.toLowerCase().includes('antigravity')) {
		vscode.window.showWarningMessage(
			'AG Usage is designed exclusively for the Antigravity IDE. It will not work correctly in this editor.',
			'I understand'
		);
	}

	state = new ExtensionState(context);
	context.subscriptions.push(state);

	context.subscriptions.push(
		vscode.commands.registerCommand(REFRESH_COMMAND, () => refresh(true)),
		vscode.commands.registerCommand(SETTINGS_COMMAND, () => vscode.commands.executeCommand('workbench.action.openSettings', CONFIG_NAMESPACE)),
		vscode.commands.registerCommand(RESET_SESSION_COMMAND, () => {
			if (state && state.lastStatsData) {
				state.sessionTracker = null;
				initializeSessionTracker(state, state.lastStatsData);
				rerenderFromCache(true);
				state.log('Session statistics reset by user');
			}
		}),
		vscode.workspace.onDidChangeConfiguration(e => {
			if (!e.affectsConfiguration(CONFIG_NAMESPACE)) { return; }
			if (!state) { return; }

			state.log('Configuration changed');

			if (e.affectsConfiguration(`${CONFIG_NAMESPACE}.trackSessionUsage`) && state.lastStatsData) {
				initializeSessionTracker(state, state.lastStatsData);
			}

			if ((e.affectsConfiguration(`${CONFIG_NAMESPACE}.notifyOnFullQuota`) || e.affectsConfiguration(`${CONFIG_NAMESPACE}.lowQuotaNotificationThreshold`)) && state.lastStatsData) {
				checkQuotaNotifications(state, state.lastStatsData);
			}

			if (e.affectsConfiguration(`${CONFIG_NAMESPACE}.refreshInterval`)) {
				startAutoRefresh();
				return;
			}

			if ((e.affectsConfiguration(`${CONFIG_NAMESPACE}.statusBarAlignment`) || e.affectsConfiguration(`${CONFIG_NAMESPACE}.statusBarPriority`)) && state) {
				state.recreateStatusBarItem();
			}

			if (!rerenderFromCache()) {
				refresh(false).catch(err => state?.log('Refresh after configuration change failed', err));
			}
		}),
		vscode.window.onDidChangeActiveColorTheme(() => {
			if (!rerenderFromCache()) {
				refresh(false).catch(err => state?.log('Refresh after theme change failed', err));
			}
		}),
		vscode.window.onDidChangeWindowState(async e => {
			if (!state || !state.sessionTracker || !state.lastStatsData) { return; }
			const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
			if (!config.get<boolean>('perWindowSession', false)) { return; }

			if (e.focused) {
				try {
					await refresh(false);
					if (state && state.sessionTracker && state.lastStatsData) {
						handleWindowFocusGained(state, state.lastStatsData);
					}
				} catch (err) {
					state?.log('Refresh on focus gain failed', err);
				}
			} else {
				handleWindowFocusLost(state, state.lastStatsData);
			}
			rerenderFromCache();
		})
	);

	state.log('Extension activated');

	state.initialRefreshTimeout = setTimeout(() => {
		startAutoRefresh(true);
	}, INITIAL_DELAY_MS);
}

export async function deactivate() {
	if (state) {
		state.log('Extension deactivating');
		if (state.refreshPromise) {
			await state.refreshPromise;
		}
		state = undefined;
	}
}

function startAutoRefresh(showFirst: boolean = false) {
	if (!state) { return; }
	state.clearTimers();

	const runLoop = async (show: boolean) => {
		if (!state || !state.isActive) { return; }

		try {
			await refresh(show);
		} catch (error) {
			state?.log('Auto-refresh failed', error);
		}

		if (!state || !state.isActive) { return; }

		const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
		const intervalSeconds = Math.max(10, config.get<number>('refreshInterval', DEFAULT_REFRESH_INTERVAL));

		let delayMs: number;
		if (state.lastRefreshSucceeded) {
			state.consecutiveFailures = 0;
			delayMs = intervalSeconds * MS_PER_SECOND;
		} else {
			state.consecutiveFailures++;
			delayMs = Math.min(
				FAILED_REFRESH_DELAY_MS * Math.pow(2, state.consecutiveFailures - 1),
				MAX_FAILED_REFRESH_DELAY_MS
			);
		}

		state.log(`Scheduling next refresh in ${delayMs / 1000}s`);
		state.refreshTimer = setTimeout(() => runLoop(false), delayMs);
	};

	runLoop(showFirst);
}

function isCacheValid(cache: CachedConnection | null): boolean {
	return !!cache && (Date.now() - cache.timestamp) < CACHE_TTL_MS;
}

function rerenderFromCache(force: boolean = false): boolean {
	if (!state || (!force && state.refreshPromise)) { return false; }
	if (!state.lastStatsData || !state.lastRefreshSucceeded) { return false; }
	try {
		const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
		const isPerWindow = config.get<boolean>('perWindowSession', false);
		const result = renderStats(state.lastStatsData, state.sessionTracker, isPerWindow);
		state.statusBarItem.text = result.text;
		state.statusBarItem.tooltip = result.tooltip;
		state.statusBarItem.color = undefined;
		return true;
	} catch (error) {
		state.log('Failed to render stats from cache', error);
		return false;
	}
}

function checkQuotaNotifications(state: ExtensionState, statsData: UsageStatistics) {
	const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
	if (config.get<boolean>('notifyOnFullQuota')) {
		const { groups } = statsData;
		for (const category of CATEGORY_ORDER) {
			const group = groups[category];
			if (group) {
				if (group.quota >= 1) {
					if (!state.fullQuotaNotifiedCategories.has(category)) {
						vscode.window.showInformationMessage(`${EXTENSION_TITLE}: Your quota for ${category} has been refilled to 100%.`);
						state.fullQuotaNotifiedCategories.add(category);
					}
				} else {
					state.fullQuotaNotifiedCategories.delete(category);
				}
			}
		}
	}

	const threshold = config.get<number>('lowQuotaNotificationThreshold', 0);
	if (threshold > 0) {
		const { groups } = statsData;
		for (const category of CATEGORY_ORDER) {
			const group = groups[category];
			if (group) {
				const percentage = group.quota * 100;
				if (percentage < threshold) {
					if (!state.lowQuotaNotifiedCategories.has(category)) {
						vscode.window.showWarningMessage(`${EXTENSION_TITLE}: ${category} has less than ${threshold}% quota remaining.`);
						state.lowQuotaNotifiedCategories.add(category);
					}
				} else {
					state.lowQuotaNotifiedCategories.delete(category);
				}
			}
		}
	}
}

function initializeSessionTracker(state: ExtensionState, statsData: UsageStatistics) {
	const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
	if (!config.get<boolean>('trackSessionUsage', true)) {
		state.sessionTracker = null;
		return;
	}

	if (state.sessionTracker) {
		updateFocusBaseline(state, statsData);
		return;
	}

	const cumulativeConsumed: Record<string, number> = {};
	const focusBaseline: Record<string, number> = {};
	const lastQuota: Record<string, number> = {};
	for (const category of CATEGORY_ORDER) {
		const group = statsData.groups[category];
		if (group) {
			cumulativeConsumed[category] = 0;
			focusBaseline[category] = group.quota;
			lastQuota[category] = group.quota;
		}
	}

	state.sessionTracker = {
		sessionStartTime: Date.now(),
		cumulativeConsumed,
		focusBaseline,
		lastQuota
	};
	state.log('Session tracker initialized');
}

function updateFocusBaseline(state: ExtensionState, statsData: UsageStatistics) {
	if (!state.sessionTracker) { return; }

	for (const category of CATEGORY_ORDER) {
		const group = statsData.groups[category];
		const tracker = state.sessionTracker;
		const lastKnown = tracker.lastQuota[category];

		if (group && lastKnown !== undefined) {
			tracker.lastQuota[category] = group.quota;
			if (tracker.focusBaseline && tracker.focusBaseline[category] !== undefined) {
				const baseline = tracker.focusBaseline[category];
				if (group.quota > lastKnown) {
					const consumedBeforeRefill = Math.max(0, baseline - lastKnown);
					tracker.cumulativeConsumed[category] =
						(tracker.cumulativeConsumed[category] ?? 0) + consumedBeforeRefill;
					tracker.focusBaseline[category] = group.quota;
					state.log(`Quota reset detected for ${category}. Banked ${consumedBeforeRefill.toFixed(4)}% consumption and updated baseline.`);
				}
			}
		}
	}
}

function handleWindowFocusLost(state: ExtensionState, statsData: UsageStatistics) {
	if (!state.sessionTracker || !state.sessionTracker.focusBaseline) { return; }

	for (const category of CATEGORY_ORDER) {
		const group = statsData.groups[category];
		const baseline = state.sessionTracker.focusBaseline[category];
		if (group && baseline !== undefined) {
			const consumed = Math.max(0, baseline - group.quota);
			state.sessionTracker.cumulativeConsumed[category] =
				(state.sessionTracker.cumulativeConsumed[category] ?? 0) + consumed;
		}
	}

	state.sessionTracker.focusBaseline = null;
	state.log('Session consumption recorded on focus loss');
}

function handleWindowFocusGained(state: ExtensionState, statsData: UsageStatistics) {
	if (!state.sessionTracker) { return; }

	const focusBaseline: Record<string, number> = {};
	for (const category of CATEGORY_ORDER) {
		const group = statsData.groups[category];
		if (group) {
			focusBaseline[category] = group.quota;
		}
	}

	state.sessionTracker.focusBaseline = focusBaseline;
	state.log('Focus baseline set on window focus');
}

async function refresh(showRefreshing: boolean) {
	if (!state || !state.isActive) { return; }

	if (state.refreshPromise) {
		if (showRefreshing) {
			state.statusBarItem.text = state.cachedConnection ? '$(sync~spin) Refreshing...' : '$(sync~spin) Connecting...';
		}
		await state.refreshPromise;
		return;
	}

	const currentState = state;

	const applyStatsUpdate = (statsData: UsageStatistics, logMessage: string) => {
		currentState.lastStatsData = statsData;
		currentState.lastRefreshSucceeded = true;
		initializeSessionTracker(currentState, statsData);
		const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
		const isPerWindow = config.get<boolean>('perWindowSession', false);
		const result = renderStats(statsData, currentState.sessionTracker, isPerWindow);
		currentState.statusBarItem.text = result.text;
		currentState.statusBarItem.tooltip = result.tooltip;
		currentState.statusBarItem.color = undefined;
		checkQuotaNotifications(currentState, statsData);
		currentState.log(logMessage);
	};

	const executeRefresh = async () => {
		if (!currentState.isActive) { return; }
		if (showRefreshing) {
			currentState.statusBarItem.text = currentState.cachedConnection ? '$(sync~spin) Refreshing...' : '$(sync~spin) Connecting...';
		}
		const minDelay = showRefreshing ? new Promise(r => setTimeout(r, MIN_DISPLAY_DELAY_MS)) : Promise.resolve();

		try {
			let statsData: UsageStatistics;

			if (USE_MOCK_DATA) {
				await minDelay;
				if (!currentState.isActive) { return; }
				statsData = await loadMockUsageStatistics();
				applyStatsUpdate(statsData, 'Refresh completed using mock data');
				return;
			}

			const connection = currentState.cachedConnection;
			if (connection && isCacheValid(connection)) {
				try {
					[statsData] = await Promise.all([fetchStats(connection.port, connection.csrfToken), minDelay]);
					if (!currentState.isActive) { return; }
					applyStatsUpdate(statsData, 'Refresh completed using cached connection');
					return;
				} catch (error) {
					currentState.log('Cached connection failed, attempting reconnection', error);
					currentState.cachedConnection = null;
				}
			}

			currentState.log('Searching for Antigravity process');
			const processInfo = await findAntigravityProcess();
			if (!currentState.isActive) { return; }
			currentState.log(`Found process with PID: ${processInfo.pid}`);

			const csrfToken = extractCsrfToken(processInfo.cmd);
			if (!csrfToken) {
				throw new Error('CSRF token not found in process command line');
			}

			const ports = await findListeningPorts(processInfo.pid);
			if (!currentState.isActive) { return; }
			if (ports.length === 0) {
				throw new Error('No listening ports found for the Antigravity process');
			}
			currentState.log(`Found ${ports.length} listening port(s): ${ports.join(', ')}`);

			const port = await findValidPort(ports, csrfToken);
			if (!currentState.isActive) { return; }
			currentState.log(`Validated port: ${port}`);

			currentState.cachedConnection = { port, csrfToken, timestamp: Date.now() };

			[statsData] = await Promise.all([fetchStats(port, csrfToken), minDelay]);
			if (!currentState.isActive) { return; }
			applyStatsUpdate(statsData, 'Refresh completed successfully');
		} catch (error) {
			if (!currentState.isActive) { return; }
			currentState.lastRefreshSucceeded = false;
			await minDelay;
			const err = error instanceof Error ? error : new Error(String(error));
			currentState.log('Refresh failed', err);
			currentState.statusBarItem.text = `$(error) ${EXTENSION_TITLE}`;
			currentState.statusBarItem.tooltip = createErrorTooltip(err);
		}
	};

	const execution = executeRefresh();
	currentState.refreshPromise = execution;

	try {
		await execution;
	} finally {
		currentState.refreshPromise = null;
	}
}
