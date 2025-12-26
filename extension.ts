import { exec } from 'child_process';
import * as https from 'https';
import * as os from 'os';
import { promisify } from 'util';
import * as vscode from 'vscode';

const execAsync = promisify(exec);

interface ProcessInfo { pid: number; cmd: string; }
interface WindowsProcessData { ProcessId: number; CommandLine: string; }
interface QuotaInfo { remainingFraction: number; resetTime?: string; }
interface ModelConfig { label: string; quotaInfo?: QuotaInfo; }
interface GroupData { quota: number; resetTime: Date | null; }
interface CachedConnection { port: number; token: string; }

export interface ServerUserStatusResponse {
	userStatus: {
		cascadeModelConfigData?: { clientModelConfigs: ModelConfig[]; };
	};
}

let statusBarItem: vscode.StatusBarItem;
let refreshInterval: NodeJS.Timeout | undefined;
let cachedConnection: CachedConnection | null = null;

export function activate(context: vscode.ExtensionContext) {
	statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBarItem.command = 'ag-usage.refresh';
	statusBarItem.text = '$(rocket) AG Usage';
	statusBarItem.show();
	context.subscriptions.push(statusBarItem, vscode.commands.registerCommand('ag-usage.refresh', () => refresh()));

	setTimeout(refresh, 1500);
	startAutoRefresh();

	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('ag-usage.refreshInterval')) {
			startAutoRefresh();
		}
	}));
}

export function deactivate() { stopAutoRefresh(); }

function startAutoRefresh() {
	stopAutoRefresh();
	const intervalSeconds = vscode.workspace.getConfiguration('ag-usage').get<number>('refreshInterval', 60);
	if (intervalSeconds > 0) {
		refreshInterval = setInterval(() => refresh(false), intervalSeconds * 1000);
	}
}

function stopAutoRefresh() {
	if (refreshInterval) {
		clearInterval(refreshInterval);
		refreshInterval = undefined;
	}
}

async function refresh(showRefreshing?: boolean) {
	if (showRefreshing !== false) statusBarItem.text = cachedConnection ? '$(sync~spin) Refreshing...' : '$(sync~spin) Connecting...';
	const minDelay = showRefreshing !== false ? new Promise(r => setTimeout(r, 300)) : Promise.resolve();
	try {
		let statsData: StatsData;
		if (cachedConnection) {
			try {
				[statsData] = await Promise.all([fetchStats(cachedConnection.port, cachedConnection.token), minDelay]);
				renderStats(statsData);
				return;
			} catch (_) { cachedConnection = null; }
		}

		const processInfo = await findAntigravityProcess();
		const csrfToken = processInfo.cmd.match(/--csrf_token[=\s]+([a-f0-9\-]+)/i)?.[1];
		if (!csrfToken) throw new Error('Token not found');
		const port = await findValidPort(await findListeningPorts(processInfo.pid), csrfToken);
		cachedConnection = { port, token: csrfToken };
		[statsData] = await Promise.all([fetchStats(port, csrfToken), minDelay]);
		renderStats(statsData);
	} catch (_) {
		await minDelay;
		statusBarItem.text = '$(error) AG Usage';
		statusBarItem.tooltip = 'Process not found or connection failed';
	}
}

async function findAntigravityProcess(): Promise<ProcessInfo> {
	let processes: ProcessInfo[];
	if (os.platform() === 'win32') {
		const cmd = `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object {$_.CommandLine -like '*language_server*'} | Select-Object ProcessId,CommandLine | ConvertTo-Json"`;
		const processData: WindowsProcessData | WindowsProcessData[] = JSON.parse((await execAsync(cmd)).stdout || '[]');
		processes = (Array.isArray(processData) ? processData : [processData]).map(proc => ({ pid: proc.ProcessId, cmd: proc.CommandLine || '' }));
	} else {
		const { stdout } = await execAsync("ps aux | grep language_server");
		processes = stdout.split('\n').filter(line => line.includes('language_server') && !line.includes('grep')).map(line => {
			const parts = line.trim().split(/\s+/);
			return { pid: parseInt(parts[1], 10), cmd: parts.slice(10).join(' ') };
		});
	}
	const antigravityProcess = processes.find(p => p.cmd.includes('antigravity')) || processes.find(p => p.cmd.includes('--csrf_token'));
	if (!antigravityProcess) throw new Error('Process not found');
	return antigravityProcess;
}

async function findListeningPorts(pid: number): Promise<number[]> {
	const platform = os.platform();
	if (platform === 'win32') {
		const cmd = `powershell -NoProfile -Command "Get-NetTCPConnection -OwningProcess ${pid} -State Listen | Select-Object -ExpandProperty LocalPort | ConvertTo-Json"`;
		const portData = JSON.parse((await execAsync(cmd)).stdout || '[]');
		return Array.isArray(portData) ? portData : [portData];
	}
	const { stdout } = await execAsync(platform === 'darwin' ? `lsof -iTCP -sTCP:LISTEN -n -P | grep ${pid}` : `ss -tlnp | grep "pid=${pid}"`);
	const regex = platform === 'darwin' ? /:(\d+)\s+\(LISTEN\)/g : /:(\d+)\s/g;
	return (stdout.match(regex) || []).map(portMatch => parseInt(portMatch.match(/:(\d+)/)?.[1] || '0', 10)).filter(port => port > 0);
}

async function findValidPort(ports: number[], token: string): Promise<number> {
	return Promise.race([
		Promise.any(ports.map(async port => {
			await makeRequest(port, token, '/exa.language_server_pb.LanguageServerService/GetUnleashData', {
				context: { properties: { ide: 'antigravity', ideVersion: '1.0.0' } }
			});
			return port;
		})),
		new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
	]);
}

function makeRequest<T>(port: number, token: string, path: string, body: object): Promise<T> {
	return new Promise((resolve, reject) => {
		const request = https.request({
			hostname: '127.0.0.1', port, path, method: 'POST',
			headers: { 'Content-Type': 'application/json', 'X-Codeium-Csrf-Token': token, 'Connect-Protocol-Version': '1' },
			rejectUnauthorized: false, timeout: 2500
		}, response => {
			let responseData = '';
			response.on('data', chunk => responseData += chunk);
			response.on('end', () => { try { resolve(JSON.parse(responseData)); } catch (error) { reject(error); } });
		});
		request.on('error', reject);
		request.on('timeout', () => { request.destroy(); reject(new Error('Timeout')); });
		request.write(JSON.stringify(body));
		request.end();
	});
}

interface StatsData {
	groups: Record<string, GroupData>;
}

async function fetchStats(port: number, token: string): Promise<StatsData> {
	const response = await makeRequest<ServerUserStatusResponse>(port, token, '/exa.language_server_pb.LanguageServerService/GetUserStatus', {
		metadata: { ideName: 'antigravity' }
	});
	const models = response.userStatus.cascadeModelConfigData?.clientModelConfigs.filter(model => model.quotaInfo) || [];

	const groups: Record<string, GroupData> = {};
	models.forEach(model => {
		const lowerLabel = model.label.toLowerCase();
		const category = lowerLabel.includes('flash') ? 'Gemini 3 Flash' : lowerLabel.includes('gemini') ? 'Gemini 3 Pro' : 'Claude/GPT';
		if (!groups[category]) groups[category] = { quota: 1, resetTime: null };
		const modelQuota = model.quotaInfo?.remainingFraction ?? 0;
		if (modelQuota < groups[category].quota) groups[category].quota = modelQuota;
		if (model.quotaInfo?.resetTime) {
			const resetDate = new Date(model.quotaInfo.resetTime);
			if (!groups[category].resetTime || resetDate < groups[category].resetTime) groups[category].resetTime = resetDate;
		}
	});

	return { groups };
}

function renderStats(data: StatsData) {
	const { groups } = data;
	let totalQuota = 0;
	const categories = ['Gemini 3 Pro', 'Gemini 3 Flash', 'Claude/GPT'].filter(category => groups[category]);
	const colWidth = 120, colPadding = 10, barWidth = 100, barHeight = 20, height = 110;
	const totalWidth = categories.length * colWidth + (categories.length - 1) * colPadding;

	let svgContent = `<svg width="${totalWidth}" height="${height}" xmlns="http://www.w3.org/2000/svg">`;
	categories.forEach((category, index) => {
		const xPosition = index * (colWidth + colPadding), centerX = xPosition + colWidth / 2;
		const group = groups[category], percentage = Math.round(group.quota * 100);
		totalQuota += group.quota;
		let remainingTime: string | null = null;
		let diffMs = 0;
		if (group.quota < 1 && group.resetTime) {
			diffMs = group.resetTime.getTime() - Date.now();
			if (diffMs <= 0) remainingTime = 'Soon';
			else {
				const days = Math.floor(diffMs / 86400000);
				const hours = Math.floor((diffMs % 86400000) / 3600000);
				const minutes = Math.floor((diffMs % 3600000) / 60000);
				remainingTime = days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
			}
		}
		const barColor = percentage >= 70 ? '#449d44' : percentage >= 30 ? '#ec971f' : '#c9302c';
		const timeColor = remainingTime && diffMs < 3600000 ? '#449d44' : '#ccc';
		svgContent += `
		<text x="${centerX}" y="21" fill="#ccc" text-anchor="middle" font-family="sans-serif" font-size="12" font-weight="bold">${category}</text>
		<rect x="${xPosition + 10}" y="30" rx="4" width="${barWidth}" height="${barHeight}" fill="#555"/>
		<rect x="${xPosition + 10}" y="30" rx="4" width="${(group.quota * barWidth).toFixed(1)}" height="${barHeight}" fill="${barColor}"/>
		<text x="${centerX}" y="45" fill="#010101" fill-opacity=".3" text-anchor="middle" font-family="sans-serif" font-size="12" font-weight="bold">${percentage}%</text>
		<text x="${centerX}" y="44" fill="#fff" text-anchor="middle" font-family="sans-serif" font-size="12" font-weight="bold">${percentage}%</text>`;

		if (remainingTime) {
			svgContent += `<text x="${centerX + 2}" y="77" fill="${timeColor}" text-anchor="middle" font-family="sans-serif" font-size="13" font-weight="bold">${remainingTime} ⏳</text>`;
		}
	});
	svgContent += `<text x="${totalWidth / 2}" y="${height - 4}" fill="#666" text-anchor="middle" font-family="sans-serif" font-size="11">Click to refresh. Models are grouped according to how quota is calculated.</text></svg>`;

	const md = new vscode.MarkdownString();
	md.appendMarkdown(`<img src="data:image/svg+xml;base64,${Buffer.from(svgContent).toString('base64')}"/>`);
	md.isTrusted = true;
	md.supportHtml = true;
	const averageQuota = categories.length > 0 ? totalQuota / categories.length : 0;
	statusBarItem.text = `$(rocket) ${Math.round(averageQuota * 100)}%`;
	statusBarItem.tooltip = md;
}