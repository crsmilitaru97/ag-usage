"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const child_process_1 = require("child_process");
const https = __importStar(require("https"));
const os = __importStar(require("os"));
const util_1 = require("util");
const vscode = __importStar(require("vscode"));
const execAsync = (0, util_1.promisify)(child_process_1.exec);
const INITIAL_DELAY_MS = 2500;
const REFRESH_INTERVAL_MS = 60000;
const REQUEST_TIMEOUT_MS = 2000;
const PORT_DISCOVERY_TIMEOUT_MS = 5000;
let statusBarItem;
let refreshInterval;
let cachedConnection = null;
function activate(context) {
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'ag-usage.refresh';
    statusBarItem.text = '$(rocket) AG Usage';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem, vscode.commands.registerCommand('ag-usage.refresh', () => refresh()));
    setTimeout(refresh, INITIAL_DELAY_MS);
    refreshInterval = setInterval(() => refresh(false), REFRESH_INTERVAL_MS);
}
function deactivate() { clearInterval(refreshInterval); }
async function refresh(showRefreshing) {
    if (showRefreshing !== false)
        statusBarItem.text = cachedConnection ? '$(sync~spin) Refreshing...' : '$(sync~spin) Connecting...';
    const minDelay = showRefreshing !== false ? new Promise(r => setTimeout(r, 300)) : Promise.resolve();
    try {
        let statsData;
        if (cachedConnection) {
            try {
                [statsData] = await Promise.all([fetchStats(cachedConnection.port, cachedConnection.token), minDelay]);
                renderStats(statsData);
                return;
            }
            catch {
                cachedConnection = null;
            }
        }
        const processInfo = await findAntigravityProcess();
        const csrfToken = processInfo.cmd.match(/--csrf_token[=\s]+([a-f0-9\-]+)/i)?.[1];
        if (!csrfToken)
            throw new Error('Token not found');
        const port = await findValidPort(await findListeningPorts(processInfo.pid), csrfToken);
        cachedConnection = { port, token: csrfToken };
        [statsData] = await Promise.all([fetchStats(port, csrfToken), minDelay]);
        renderStats(statsData);
    }
    catch {
        await minDelay;
        statusBarItem.text = '$(error) AG Usage';
        statusBarItem.tooltip = 'Process not found or connection failed';
    }
}
async function findAntigravityProcess() {
    let processes;
    if (os.platform() === 'win32') {
        const cmd = `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object {$_.CommandLine -like '*language_server*'} | Select-Object ProcessId,CommandLine | ConvertTo-Json"`;
        const processData = JSON.parse((await execAsync(cmd)).stdout || '[]');
        processes = (Array.isArray(processData) ? processData : [processData]).map(proc => ({ pid: proc.ProcessId, cmd: proc.CommandLine || '' }));
    }
    else {
        const { stdout } = await execAsync("ps aux | grep language_server");
        processes = stdout.split('\n').filter(line => line.includes('language_server') && !line.includes('grep')).map(line => {
            const parts = line.trim().split(/\s+/);
            return { pid: parseInt(parts[1], 10), cmd: parts.slice(10).join(' ') };
        });
    }
    const antigravityProcess = processes.find(p => p.cmd.includes('antigravity')) || processes.find(p => p.cmd.includes('--csrf_token'));
    if (!antigravityProcess)
        throw new Error('Process not found');
    return antigravityProcess;
}
async function findListeningPorts(pid) {
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
async function findValidPort(ports, token) {
    return Promise.race([
        (async () => {
            for (const port of ports) {
                try {
                    await makeRequest(port, token, '/exa.language_server_pb.LanguageServerService/GetUnleashData', {
                        context: { properties: { ide: 'antigravity', ideVersion: '1.0.0' } }
                    });
                    return port;
                }
                catch {
                    continue;
                }
            }
            throw new Error('No valid port found');
        })(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), PORT_DISCOVERY_TIMEOUT_MS))
    ]);
}
function makeRequest(port, token, path, body) {
    return new Promise((resolve, reject) => {
        const request = https.request({
            hostname: '127.0.0.1', port, path, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Codeium-Csrf-Token': token, 'Connect-Protocol-Version': '1' },
            rejectUnauthorized: false, timeout: REQUEST_TIMEOUT_MS
        }, response => {
            let responseData = '';
            response.on('data', chunk => responseData += chunk);
            response.on('end', () => { try {
                resolve(JSON.parse(responseData));
            }
            catch (error) {
                reject(error);
            } });
        });
        request.on('error', reject);
        request.on('timeout', () => { request.destroy(); reject(new Error('Timeout')); });
        request.write(JSON.stringify(body));
        request.end();
    });
}
async function fetchStats(port, token) {
    const response = await makeRequest(port, token, '/exa.language_server_pb.LanguageServerService/GetUserStatus', {
        metadata: { ideName: 'antigravity' }
    });
    const models = response.userStatus.cascadeModelConfigData?.clientModelConfigs.filter(model => model.quotaInfo) || [];
    const groups = {};
    models.forEach(model => {
        const lowerLabel = model.label.toLowerCase();
        const category = lowerLabel.includes('flash') ? 'Gemini 3 Flash' : lowerLabel.includes('gemini') ? 'Gemini 3 Pro' : 'Claude/GPT';
        if (!groups[category])
            groups[category] = { total: 0, count: 0, resetTime: null };
        groups[category].total += model.quotaInfo?.remainingFraction || 0;
        groups[category].count++;
        if (model.quotaInfo?.resetTime) {
            const resetDate = new Date(model.quotaInfo.resetTime);
            if (!groups[category].resetTime || resetDate < groups[category].resetTime)
                groups[category].resetTime = resetDate;
        }
    });
    return { groups };
}
function renderStats(data) {
    const { groups } = data;
    let totalAvg = 0, totalCount = 0;
    const categories = ['Gemini 3 Pro', 'Gemini 3 Flash', 'Claude/GPT'].filter(category => groups[category]);
    const colWidth = 120, colPadding = 10, barWidth = 100, barHeight = 20, height = 115;
    const totalWidth = categories.length * colWidth + (categories.length - 1) * colPadding;
    let svgContent = `<svg width="${totalWidth}" height="${height}" xmlns="http://www.w3.org/2000/svg">`;
    categories.forEach((category, index) => {
        const xPosition = index * (colWidth + colPadding), centerX = xPosition + colWidth / 2;
        const group = groups[category], average = group.total / group.count, percentage = Math.round(average * 100);
        let remainingTime = null;
        if (group.resetTime) {
            const diffMs = group.resetTime.getTime() - Date.now();
            if (diffMs <= 0)
                remainingTime = { hours: 0, minutes: 0, display: 'Soon' };
            else {
                const days = Math.floor(diffMs / 86400000);
                const hours = Math.floor((diffMs % 86400000) / 3600000);
                const minutes = Math.floor((diffMs % 3600000) / 60000);
                const display = days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
                remainingTime = { hours, minutes, display };
            }
        }
        const barColor = percentage >= 70 ? '#449d44' : percentage >= 30 ? '#ec971f' : '#c9302c';
        const timeColor = remainingTime && remainingTime.hours < 1 ? '#449d44' : '#ccc';
        totalAvg += average;
        totalCount++;
        svgContent += `
		<text x="${centerX}" y="21" fill="#ccc" text-anchor="middle" font-family="sans-serif" font-size="12" font-weight="bold">${category}</text>
		<rect x="${xPosition + 10}" y="30" rx="4" width="${barWidth}" height="${barHeight}" fill="#555"/>
		<rect x="${xPosition + 10}" y="30" rx="4" width="${(average * barWidth).toFixed(1)}" height="${barHeight}" fill="${barColor}"/>
		<text x="${centerX}" y="45" fill="#010101" fill-opacity=".3" text-anchor="middle" font-family="sans-serif" font-size="12" font-weight="bold">${percentage}%</text>
		<text x="${centerX}" y="44" fill="#fff" text-anchor="middle" font-family="sans-serif" font-size="12" font-weight="bold">${percentage}%</text>
		<text x="${centerX + 2}" y="77" fill="${timeColor}" text-anchor="middle" font-family="sans-serif" font-size="13" font-weight="bold">${remainingTime?.display || '--'} ⏳</text>`;
    });
    svgContent += `<text x="${totalWidth / 2}" y="${height - 4}" fill="#666" text-anchor="middle" font-family="sans-serif" font-size="10">Click to refresh</text></svg>`;
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`<img src="data:image/svg+xml;base64,${Buffer.from(svgContent).toString('base64')}"/>`);
    md.isTrusted = true;
    md.supportHtml = true;
    statusBarItem.text = `$(rocket) ${totalCount > 0 ? Math.round((totalAvg / totalCount) * 100) : 0}%`;
    statusBarItem.tooltip = md;
}
