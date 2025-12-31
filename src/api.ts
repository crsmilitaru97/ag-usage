import { spawn } from 'child_process';
import * as https from 'https';
import * as os from 'os';
import * as fs from 'fs';
import {
  CATEGORY_NAMES,
  IDE_INFO,
  MAX_PORT,
  MAX_PORT_VALIDATION_ATTEMPTS,
  MAX_VALID_PID,
  MIN_PORT,
  MODEL_KEYWORDS,
  PROCESS_IDENTIFIERS,
  REQUEST_TIMEOUT_MS,
  RETRY_DELAY_MS
} from './constants';
import { ProcessId, ProcessInfo, QuotaGroup, ServerUserStatusResponse, UsageStatistics } from './types';

const LOCALHOST = '127.0.0.1';

const API_ENDPOINTS = {
  GET_UNLEASH_DATA: '/exa.language_server_pb.LanguageServerService/GetUnleashData',
  GET_USER_STATUS: '/exa.language_server_pb.LanguageServerService/GetUserStatus'
};

const MAX_BUFFER_SIZE = 1024 * 1024;
function executeCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { shell: false });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => {
      if (stdout.length + data.length > MAX_BUFFER_SIZE) {
        proc.kill();
        reject(new Error(`Command output exceeded ${MAX_BUFFER_SIZE} bytes`));
        return;
      }
      stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      if (stderr.length + data.length > MAX_BUFFER_SIZE) {
        return;
      }
      stderr += data.toString();
    });

    proc.on('error', reject);

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr || `Command exited with code ${code}`));
      }
    });
  });
}

function validatePid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0 && pid <= MAX_VALID_PID;
}

function validatePort(port: number): boolean {
  return Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT;
}

function escapeLikePattern(value: string): string {
  return value.replace(/[%_\[\]\\]/g, '[$&]');
}

async function getWindowsProcesses(): Promise<ProcessInfo[]> {
  let stdout: string;
  const escapedIdentifier = escapeLikePattern(PROCESS_IDENTIFIERS.LANGUAGE_SERVER);
  try {
    stdout = await executeCommand('powershell', [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%${escapedIdentifier}%'" | Select-Object ProcessId, CommandLine | ForEach-Object { "$($_.ProcessId)|$($_.CommandLine)" }`
    ]);
  } catch {
    try {
      stdout = await executeCommand('wmic', [
        'process',
        'where',
        `CommandLine like '%${escapedIdentifier}%'`,
        'get',
        'CommandLine,ProcessId',
        '/format:csv'
      ]);
      return parseWmicOutput(stdout);
    } catch (wmicError) {
      throw new Error(`Failed to query Windows processes: ${wmicError instanceof Error ? wmicError.message : String(wmicError)}`);
    }
  }

  const processes: ProcessInfo[] = [];
  const lines = stdout.trim().split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { continue; }

    const separatorIndex = trimmed.indexOf('|');
    if (separatorIndex === -1) { continue; }

    const pidStr = trimmed.substring(0, separatorIndex).trim();
    const pid = parseInt(pidStr, 10);
    const cmd = trimmed.substring(separatorIndex + 1).trim();

    if (validatePid(pid) && cmd) {
      processes.push({ pid, cmd });
    }
  }

  return processes;
}

function parseWmicOutput(stdout: string): ProcessInfo[] {
  const lines = stdout.trim().split(/\r?\n/);
  const processes: ProcessInfo[] = [];

  for (const line of lines) {
    if (!line || line.startsWith('Node,')) { continue; }
    const lastCommaIndex = line.lastIndexOf(',');
    if (lastCommaIndex === -1) { continue; }

    const pidStr = line.substring(lastCommaIndex + 1).trim();
    const pid = parseInt(pidStr, 10);
    const firstCommaIndex = line.indexOf(',');
    if (firstCommaIndex === -1 || firstCommaIndex === lastCommaIndex) { continue; }

    const cmd = line.substring(firstCommaIndex + 1, lastCommaIndex).trim();

    if (validatePid(pid)) {
      processes.push({ pid, cmd });
    }
  }

  return processes;
}

async function getUnixProcesses(): Promise<ProcessInfo[]> {
  let stdout: string;
  try {
    stdout = await executeCommand('ps', ['-eo', 'pid,args']);
  } catch (error) {
    throw new Error(`Failed to query Unix processes: ${error instanceof Error ? error.message : String(error)}`);
  }

  return stdout
    .split('\n')
    .filter(line => line.includes(PROCESS_IDENTIFIERS.LANGUAGE_SERVER))
    .map(line => {
      const trimmed = line.trim();
      const match = trimmed.match(/^(\d+)\s+(.+)$/);
      if (!match) { return null; }
      const pid = parseInt(match[1], 10);
      const cmdText = match[2].trim();
      return cmdText ? { pid, cmd: cmdText } : null;
    })
    .filter((p): p is ProcessInfo => p !== null && validatePid(p.pid));
}

export async function findAntigravityProcess(): Promise<ProcessInfo> {
  const processes = os.platform() === 'win32'
    ? await getWindowsProcesses()
    : await getUnixProcesses();

  const currentUserUid = os.platform() === 'linux' ? os.userInfo().uid : -1;
  const currentHome = os.homedir();

  const candidateProcesses = processes.filter(p => os.platform() !== 'linux' || isValidProcess(p.pid, currentUserUid, currentHome));

  const antigravityProcess = candidateProcesses.find(p =>
    p.cmd.includes(PROCESS_IDENTIFIERS.ANTIGRAVITY) || p.cmd.includes(PROCESS_IDENTIFIERS.CSRF_TOKEN)
  );

  if (!antigravityProcess) {
    throw new Error('Antigravity process not found. Make sure Antigravity is running.');
  }

  return antigravityProcess;
}

function isValidProcess(pid: number, expectedUid: number, expectedHome: string): boolean {
  try {
    return fs.statSync(`/proc/${pid}`).uid === expectedUid &&
      getEnvValue(fs.readFileSync(`/proc/${pid}/environ`), 'HOME') === expectedHome;
  } catch {
    return false;
  }
}

function getEnvValue(environ: Buffer, keyToFind: string): string | undefined {
  return environ.toString().split('\0')
    .find(line => line.startsWith(keyToFind + '='))
    ?.substring(keyToFind.length + 1);
}

async function getWindowsPorts(pid: ProcessId): Promise<number[]> {
  let stdout: string;
  try {
    stdout = await executeCommand('powershell', [
      '-NoProfile',
      '-Command',
      `Get-NetTCPConnection -OwningProcess ${pid} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort`
    ]);
  } catch {
    try {
      stdout = await executeCommand('netstat', ['-ano', '-p', 'tcp']);
      return parseNetstatOutput(stdout, pid);
    } catch (error) {
      throw new Error(`Failed to query Windows ports: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const ports: number[] = [];
  for (const line of stdout.trim().split(/\r?\n/)) {
    const port = parseInt(line.trim(), 10);
    if (validatePort(port)) {
      ports.push(port);
    }
  }
  return ports;
}

function parseNetstatOutput(stdout: string, pid: ProcessId): number[] {
  const ports: number[] = [];
  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) { continue; }

    const linePid = parseInt(parts[parts.length - 1], 10);
    if (linePid !== pid) { continue; }

    const localAddress = parts[1];
    const lastColon = localAddress.lastIndexOf(':');
    if (lastColon !== -1) {
      const port = parseInt(localAddress.substring(lastColon + 1), 10);
      if (validatePort(port)) {
        ports.push(port);
      }
    }
  }
  return ports;
}

async function getUnixPorts(pid: ProcessId): Promise<number[]> {
  const platform = os.platform();

  if (platform === 'darwin') {
    try {
      const stdout = await executeCommand('lsof', ['-iTCP', '-sTCP:LISTEN', '-n', '-P', '-p', String(pid)]);
      return parseUnixLsofOutput(stdout);
    } catch (error) {
      throw new Error(`Failed to query Unix ports calling lsof: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const queries = [
    { type: 'ss', cmd: 'ss', args: ['-tlnp'] },
    { type: 'lsof', cmd: 'lsof', args: ['-iTCP', '-sTCP:LISTEN', '-n', '-P', '-p', String(pid)] },
    { type: 'netstat', cmd: 'netstat', args: ['-tlnp'] }
  ];

  const errors: string[] = [];

  for (const { type, cmd, args } of queries) {
    try {
      const stdout = await executeCommand(cmd, args);
      if (type === 'ss') return parseUnixSsOutput(stdout, pid);
      if (type === 'lsof') return parseUnixLsofOutput(stdout);
      if (type === 'netstat') return parseUnixNetstatOutput(stdout, pid);
    } catch (error) {
      errors.push(`${cmd}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`Failed to query Unix ports. Attempts: ${errors.join('; ')}`);
}

function parseUnixLsofOutput(stdout: string): number[] {
  const ports: number[] = [];
  const regex = /:(\d+)\s+\(LISTEN\)/g;
  let match;
  while ((match = regex.exec(stdout)) !== null) {
    const port = parseInt(match[1], 10);
    if (validatePort(port)) {
      ports.push(port);
    }
  }
  return ports;
}

function parseUnixSsOutput(stdout: string, pid: number): number[] {
  const ports: number[] = [];
  const lines = stdout.split('\n');
  const pidPattern = new RegExp(`pid=${pid}\\b`);
  for (const line of lines) {
    if (!pidPattern.test(line)) { continue; }
    const portMatch = line.match(/:(\d+)\s/);
    if (portMatch) {
      const port = parseInt(portMatch[1], 10);
      if (validatePort(port)) {
        ports.push(port);
      }
    }
  }
  return ports;
}

function parseUnixNetstatOutput(stdout: string, pid: number): number[] {
  const ports: number[] = [];
  const lines = stdout.split('\n');
  const pidPattern = new RegExp(`\\b${pid}/`);
  for (const line of lines) {
    if (!pidPattern.test(line)) { continue; }
    const portMatch = line.match(/:(\d+)\s/);
    if (portMatch) {
      const port = parseInt(portMatch[1], 10);
      if (validatePort(port)) {
        ports.push(port);
      }
    }
  }
  return ports;
}

export async function findListeningPorts(pid: ProcessId): Promise<number[]> {
  if (!validatePid(pid)) {
    throw new Error(`Invalid process ID: ${pid}`);
  }

  const rawPorts = os.platform() === 'win32'
    ? await getWindowsPorts(pid)
    : await getUnixPorts(pid);

  return Array.from(new Set(rawPorts));
}

async function checkPort(port: number, csrfToken: string): Promise<void> {
  await makeRequest(port, csrfToken, API_ENDPOINTS.GET_UNLEASH_DATA, {
    context: { properties: { ide: IDE_INFO.NAME, ideVersion: IDE_INFO.VERSION } }
  });
}

const NON_RETRIABLE_PATTERNS = [
  /unauthorized|forbidden|401|403/i,
  /invalid.*token|token.*invalid/i,
  /certificate|ssl|tls/i
];

function isNonRetriableError(message: string): boolean {
  return NON_RETRIABLE_PATTERNS.some(pattern => pattern.test(message));
}

export async function findValidPort(ports: number[], csrfToken: string): Promise<number> {
  if (ports.length === 0) {
    throw new Error('No listening ports found for the Antigravity process');
  }

  const errors: Map<number, string> = new Map();
  const maxAttempts = MAX_PORT_VALIDATION_ATTEMPTS;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await delay(RETRY_DELAY_MS);
    }

    errors.clear();

    try {
      return await Promise.any(ports.map(async (port) => {
        try {
          await checkPort(port, csrfToken);
          return port;
        } catch (error) {
          errors.set(port, error instanceof Error ? error.message : String(error));
          throw error;
        }
      }));
    } catch {
      const allNonRetriable = errors.size === ports.length &&
        Array.from(errors.values()).every(isNonRetriableError);

      if (allNonRetriable) {
        break;
      }
    }
  }

  const uniqueErrors = new Set(errors.values());
  if (uniqueErrors.size === 1) {
    throw new Error(`All ${ports.length} ports failed: ${[...uniqueErrors][0]}`);
  }
  const errorSummary = Array.from(errors.entries())
    .slice(0, 5)
    .map(([port, msg]) => `${port}: ${msg}`)
    .join('; ');
  throw new Error(`All port checks failed. [${errorSummary}]`);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function makeRequest<T>(port: number, csrfToken: string, path: string, body: object, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!validatePort(port)) {
      return reject(new Error(`Invalid port: ${port}`));
    }

    if (signal?.aborted) {
      return reject(new Error('Request aborted'));
    }

    const payload = JSON.stringify(body);
    let cleanedUp = false;
    let request: ReturnType<typeof https.request> | null = null;

    const abortHandler = signal ? () => {
      cleanup();
      request?.destroy();
      reject(new Error('Request aborted'));
    } : null;

    const cleanup = () => {
      if (cleanedUp) { return; }
      cleanedUp = true;
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    };

    if (signal && abortHandler) {
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    request = https.request({
      hostname: LOCALHOST,
      port,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'X-Codeium-Csrf-Token': csrfToken,
        'Connect-Protocol-Version': '1'
      },
      timeout: REQUEST_TIMEOUT_MS,
      rejectUnauthorized: false
    }, response => {
      response.setEncoding('utf8');
      let responseData = '';

      response.on('data', chunk => {
        responseData += chunk;
      });

      response.on('end', () => {
        cleanup();
        const statusCode = response.statusCode ?? 0;
        if (statusCode < 200 || statusCode >= 300) {
          return reject(new Error(`HTTP request failed with status ${statusCode}`));
        }
        try {
          resolve(JSON.parse(responseData));
        } catch {
          reject(new Error('Failed to parse server response as JSON'));
        }
      });

      response.on('error', (err) => {
        cleanup();
        reject(err);
      });
    });

    request.on('error', (err) => {
      cleanup();
      reject(err);
    });

    request.on('timeout', () => {
      cleanup();
      request.destroy();
      reject(new Error('Request timed out'));
    });

    request.write(payload);
    request.end();
  });
}

function determineCategory(label: string): string {
  const lowerLabel = label.toLowerCase();
  if (lowerLabel.includes(MODEL_KEYWORDS.flash)) { return CATEGORY_NAMES.GEMINI_FLASH; }
  if (lowerLabel.includes(MODEL_KEYWORDS.gemini)) { return CATEGORY_NAMES.GEMINI_PRO; }
  return CATEGORY_NAMES.CLAUDE_GPT;
}

export async function fetchStats(port: number, csrfToken: string): Promise<UsageStatistics> {
  const response = await makeRequest<ServerUserStatusResponse>(
    port,
    csrfToken,
    API_ENDPOINTS.GET_USER_STATUS,
    { metadata: { ideName: IDE_INFO.NAME } }
  );

  const models = response.userStatus?.cascadeModelConfigData?.clientModelConfigs ?? [];
  const groups: Record<string, QuotaGroup> = {};

  for (const model of models) {
    const { quotaInfo, label } = model;
    const remainingFraction = quotaInfo?.remainingFraction;

    if (remainingFraction !== undefined && remainingFraction !== null && (typeof remainingFraction !== 'number' || !Number.isFinite(remainingFraction))) {
      continue;
    }

    const modelQuota = remainingFraction ?? 0;

    const category = determineCategory(label);
    const group = groups[category] ??= { quota: 1, resetTime: null };

    if (modelQuota < group.quota) {
      group.quota = modelQuota;
    }

    const resetTimeStr = quotaInfo?.resetTime;
    if (typeof resetTimeStr === 'string' && resetTimeStr.length > 0) {
      const resetTimestamp = new Date(resetTimeStr).getTime();
      if (Number.isFinite(resetTimestamp)) {
        if (group.resetTime === null || resetTimestamp < group.resetTime) {
          group.resetTime = resetTimestamp;
        }
      }
    }
  }

  return { groups };
}
