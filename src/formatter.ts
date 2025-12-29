import * as vscode from 'vscode';
import { CONFIG_NAMESPACE, DISPLAY_MODE_TO_CATEGORY, MAX_STATUS_TEXT_LENGTH, MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE, SHORT_NAMES } from './constants';
import { QuotaGroup, StatusBarDisplayMode } from './types';

export function formatRemainingTime(targetTime: number): { text: string; diffMs: number } {
  const diffMs = targetTime - Date.now();

  if (diffMs <= 0) {
    return { text: 'Soon', diffMs: 0 };
  }

  const days = Math.floor(diffMs / MS_PER_DAY);
  const hours = Math.floor((diffMs % MS_PER_DAY) / MS_PER_HOUR);
  const minutes = Math.floor((diffMs % MS_PER_HOUR) / MS_PER_MINUTE);

  let text: string;
  if (days > 0) {
    text = `${days}d ${hours}h`;
  } else if (hours > 0) {
    text = `${hours}h ${minutes}m`;
  } else {
    text = `${minutes}m`;
  }

  return { text, diffMs };
}

export function formatStatusBarText(
  groups: Record<string, QuotaGroup>,
  categories: string[]
): string {
  const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
  const displayMode = config.get<StatusBarDisplayMode>('statusBarDisplay', 'average');

  if (displayMode === 'all') {
    const parts = categories.map(cat => `${SHORT_NAMES[cat] ?? cat}: ${Math.round(groups[cat].quota * 100)}%`);
    const text = parts.join(' | ');
    const truncated = text.length > MAX_STATUS_TEXT_LENGTH
      ? text.slice(0, MAX_STATUS_TEXT_LENGTH - 1) + '…'
      : text;
    return `$(rocket) ${truncated}`;
  }

  if (displayMode !== 'average') {
    const category = DISPLAY_MODE_TO_CATEGORY[displayMode];
    if (category && groups[category]) {
      const shortName = SHORT_NAMES[category];
      return `$(rocket) ${shortName ?? category}: ${Math.round(groups[category].quota * 100)}%`;
    }
  }

  if (categories.length === 0) {
    return '$(rocket) 0%';
  }

  const totalQuota = categories.reduce((sum, cat) => sum + groups[cat].quota, 0);
  const averageQuota = totalQuota / categories.length;
  return `$(rocket) ${Math.round(averageQuota * 100)}%`;
}

const ERROR_PATTERNS: Array<{ pattern: RegExp; tooltip: string }> = [
  { pattern: /process not found|not found.*process/i, tooltip: 'Antigravity process not found. Make sure Antigravity is running.' },
  { pattern: /csrf[_\s]?token/i, tooltip: 'Could not extract CSRF token from process. The process may have started incorrectly.' },
  { pattern: /no listening ports|ports? (not )?found/i, tooltip: 'No listening ports found for the Antigravity process.' },
  { pattern: /timed? ?out|timeout/i, tooltip: 'Connection timed out. The server may not be responding.' },
  { pattern: /econnrefused|connection refused/i, tooltip: 'Connection refused. The server may not be running.' },
  { pattern: /enotfound|dns/i, tooltip: 'Could not resolve host. Check your network connection.' }
];

export function createErrorTooltip(error: Error): string {
  const message = error.message;
  for (const { pattern, tooltip } of ERROR_PATTERNS) {
    if (pattern.test(message)) {
      return tooltip;
    }
  }
  return `Connection failed: ${message}. Click to retry.`;
}
