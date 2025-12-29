import * as vscode from 'vscode';
import { fetchStats, findAntigravityProcess, findListeningPorts, findValidPort } from './api';
import {
	CACHE_TTL_MS,
	CONFIG_NAMESPACE,
	DEFAULT_REFRESH_INTERVAL,
	FAILED_REFRESH_DELAY_MS,
	INITIAL_DELAY_MS,
	MAX_FAILED_REFRESH_DELAY_MS,
	MIN_DISPLAY_DELAY_MS,
	MS_PER_SECOND,
	REFRESH_COMMAND,
	SETTINGS_COMMAND,
	STATUS_BAR_PRIORITY
} from './constants';
import { createErrorTooltip } from './formatter';
import { renderStats } from './renderer';
import { CachedConnection, UsageStatistics } from './types';

class ExtensionState {
	private readonly outputChannel: vscode.OutputChannel;
	statusBarItem: vscode.StatusBarItem;
	refreshTimer?: ReturnType<typeof setTimeout>;
	initialRefreshTimeout?: ReturnType<typeof setTimeout>;
	cachedConnection: CachedConnection | null = null;
	lastStatsData: UsageStatistics | null = null;
	refreshPromise: Promise<void> | null = null;
	lastRefreshSucceeded = false;
	consecutiveFailures = 0;
	isActive = false;

	constructor(context: vscode.ExtensionContext) {
		this.outputChannel = vscode.window.createOutputChannel('AG Usage');
		this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, STATUS_BAR_PRIORITY);
		this.statusBarItem.command = REFRESH_COMMAND;
		this.statusBarItem.text = '$(rocket) AG Usage';
		this.isActive = true;

		context.subscriptions.push(this.outputChannel, this.statusBarItem);
	}

	dispose() {
		this.isActive = false;
		this.clearTimers();
		this.cachedConnection = null;
		this.lastStatsData = null;
		this.refreshPromise = null;
		this.lastRefreshSucceeded = false;
		this.consecutiveFailures = 0;
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
			? `[${timestamp}] ${message}: ${error instanceof Error ? error.message : String(error)}`
			: `[${timestamp}] ${message}`;
		this.outputChannel.appendLine(logMessage);
	}
}

let state: ExtensionState | undefined;

export function activate(context: vscode.ExtensionContext) {
	state = new ExtensionState(context);
	state.statusBarItem.show();

	context.subscriptions.push(
		vscode.commands.registerCommand(REFRESH_COMMAND, () => refresh(true)),
		vscode.commands.registerCommand(SETTINGS_COMMAND, () => vscode.commands.executeCommand('workbench.action.openSettings', CONFIG_NAMESPACE)),
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(`${CONFIG_NAMESPACE}.refreshInterval`)) {
				state?.log('Refresh interval configuration changed');
				startAutoRefresh();
			}
			if (e.affectsConfiguration(`${CONFIG_NAMESPACE}.statusBarDisplay`)) {
				if (!rerenderFromCache()) {
					refresh(false).catch(err => state?.log('Refresh after display config change failed', err));
				}
			}
		}),
		vscode.window.onDidChangeActiveColorTheme(() => {
			if (!rerenderFromCache()) {
				refresh(false).catch(err => state?.log('Refresh after theme change failed', err));
			}
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
		state.dispose();
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

function rerenderFromCache(): boolean {
	if (!state || state.refreshPromise) { return false; }
	if (!state.lastStatsData || !state.lastRefreshSucceeded) { return false; }
	try {
		renderStats(state.lastStatsData, state.statusBarItem);
		return true;
	} catch (error) {
		state.log('Failed to render stats from cache', error);
		return false;
	}
}

function extractCsrfToken(cmd: string): string | undefined {
	const patterns = [
		/--csrf_token[=\s]+"([^"]+)"/i,
		/--csrf_token[=\s]+'([^']+)'/i,
		/--csrf_token[=\s]+([\w-]+)/i
	];
	for (const pattern of patterns) {
		const match = cmd.match(pattern);
		if (match?.[1]) {
			return match[1].trim();
		}
	}
	return undefined;
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

	const executeRefresh = async () => {
		if (!currentState.isActive) { return; }
		if (showRefreshing) {
			currentState.statusBarItem.text = currentState.cachedConnection ? '$(sync~spin) Refreshing...' : '$(sync~spin) Connecting...';
		}
		const minDelay = showRefreshing ? new Promise(r => setTimeout(r, MIN_DISPLAY_DELAY_MS)) : Promise.resolve();

		try {
			let statsData: UsageStatistics;

			const connection = currentState.cachedConnection;
			if (connection && isCacheValid(connection)) {
				try {
					[statsData] = await Promise.all([fetchStats(connection.port, connection.csrfToken), minDelay]);
					if (!currentState.isActive) { return; }
					currentState.lastStatsData = statsData;
					currentState.lastRefreshSucceeded = true;
					renderStats(statsData, currentState.statusBarItem);
					currentState.log('Refresh completed using cached connection');
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
			currentState.lastStatsData = statsData;
			currentState.lastRefreshSucceeded = true;
			renderStats(statsData, currentState.statusBarItem);
			currentState.log('Refresh completed successfully');

		} catch (error) {
			if (!currentState.isActive) { return; }
			currentState.lastRefreshSucceeded = false;
			await minDelay;
			const err = error instanceof Error ? error : new Error(String(error));
			currentState.log('Refresh failed', err);
			currentState.statusBarItem.text = '$(error) AG Usage';
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
