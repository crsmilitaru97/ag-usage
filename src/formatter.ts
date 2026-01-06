import * as vscode from 'vscode';
import { CONFIG_NAMESPACE, DISPLAY_MODE_TO_CATEGORY, MAX_STATUS_TEXT_LENGTH, MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE, SHORT_NAMES } from './constants';
import { AbsoluteTimeFormat, QuotaGroup, ResetTimeDisplayMode, StatusBarDisplayMode } from './types';

const monthFormatter = new Intl.DateTimeFormat(undefined, { month: 'short' });

function formatAbsoluteTime(targetTime: number, format: AbsoluteTimeFormat, diffMs: number): string {
  const date = new Date(targetTime);
  const includeDate = diffMs >= MS_PER_DAY;

  let timeStr: string;
  if (format === '12h') {
    const hours = date.getHours();
    const minutes = date.getMinutes();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours % 12 || 12;
    timeStr = `${displayHours}:${minutes.toString().padStart(2, '0')} ${ampm}`;
  } else {
    timeStr = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
  }

  if (includeDate) {
    const day = date.getDate();
    const month = monthFormatter.format(date);
    return `${day} ${month}, ${timeStr}`;
  }

  return timeStr;
}

export function formatRelativeTime(diffMs: number): string {
  if (diffMs <= 0) { return '<1m'; }
  const days = Math.floor(diffMs / MS_PER_DAY);
  const hours = Math.floor((diffMs % MS_PER_DAY) / MS_PER_HOUR);
  const minutes = Math.floor((diffMs % MS_PER_HOUR) / MS_PER_MINUTE);

  if (days > 0) return `${days}d${hours > 0 ? ` ${hours}h` : ''}`;
  if (hours > 0) return `${hours}h${minutes > 0 ? ` ${minutes}m` : ''}`;
  return minutes > 0 ? `${minutes}m` : '<1m';
}

export function formatRemainingTimeSeparate(targetTime: number): { relativeText: string; absoluteText: string | null; diffMs: number } {
  const diffMs = targetTime - Date.now();

  if (diffMs <= 0) {
    return { relativeText: 'Soon', absoluteText: null, diffMs: 0 };
  }

  const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
  const displayMode = config.get<ResetTimeDisplayMode>('resetTimeDisplay', 'both');
  const timeFormat = config.get<AbsoluteTimeFormat>('absoluteTimeFormat', '24h');

  const relativeText = formatRelativeTime(diffMs);

  if (displayMode === 'relative') {
    return { relativeText, absoluteText: null, diffMs };
  }

  const absoluteText = formatAbsoluteTime(targetTime, timeFormat, diffMs);

  if (displayMode === 'absolute') {
    return { relativeText: absoluteText, absoluteText: null, diffMs };
  }

  return { relativeText, absoluteText, diffMs };
}

function getCountdownSuffix(groups: Record<string, QuotaGroup>, categories: string[], showCountdown: boolean): string {
  if (!showCountdown) {
    return '';
  }

  if (!categories.some(cat => groups[cat]?.quota <= 0)) {
    return '';
  }

  let earliestResetTime: number | null = null;
  for (const cat of categories) {
    const group = groups[cat];
    if (group.quota <= 0 && typeof group.resetTime === 'number') {
      if (earliestResetTime === null || group.resetTime < earliestResetTime) {
        earliestResetTime = group.resetTime;
      }
    }
  }

  if (earliestResetTime === null) {
    return '';
  }

  const diffMs = Math.max(0, earliestResetTime - Date.now());
  const text = formatRelativeTime(diffMs);
  return ` ~${text}`;
}

export function formatStatusBarText(
  groups: Record<string, QuotaGroup>,
  categories: string[],
  sessionUsages?: Record<string, number> | null
): string {
  const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
  const displayMode = config.get<StatusBarDisplayMode>('statusBarDisplay', 'all');
  const showCountdown = config.get<boolean>('statusBarCountdown', true);
  const showSessionUsage = config.get<boolean>('showSessionUsageInStatusBar', false);
  const countdownSuffix = getCountdownSuffix(groups, categories, showCountdown);

  const formatGroup = (name: string, group: QuotaGroup) => {
    const label = SHORT_NAMES[name] ?? name;
    let suffix = '';

    if (showSessionUsage && sessionUsages && typeof sessionUsages[name] === 'number') {
      const usage = sessionUsages[name];
      if (usage > 0) {
        suffix = ` (-${usage}%)`;
      }
    }

    if (showCountdown && group.quota <= 0 && typeof group.resetTime === 'number') {
      const diffMs = Math.max(0, group.resetTime - Date.now());
      const shortTime = formatRelativeTime(diffMs);
      return `${label} ~${shortTime}${suffix}`;
    }
    return `${label} ${Math.round(group.quota * 100)}%${suffix}`;
  };

  if (displayMode === 'all') {
    const parts = categories.map(cat => formatGroup(cat, groups[cat]));
    const text = parts.join('   ');
    const truncated = text.length > MAX_STATUS_TEXT_LENGTH
      ? text.slice(0, MAX_STATUS_TEXT_LENGTH - 1) + '…'
      : text;
    return `$(rocket) ${truncated}`;
  }

  if (displayMode !== 'average') {
    const category = DISPLAY_MODE_TO_CATEGORY[displayMode];
    if (category && groups[category]) {
      const group = groups[category];
      return `$(rocket) ${formatGroup(category, group)}`;
    }
  }

  if (categories.length === 0) {
    if (countdownSuffix) {
      return `$(rocket)${countdownSuffix}`;
    }
    return `$(rocket) 0%`;
  }

  const totalQuota = categories.reduce((sum, cat) => sum + groups[cat].quota, 0);
  const averageQuota = totalQuota / categories.length;
  const percentage = Math.round(averageQuota * 100);

  let avgSuffix = '';
  if (showSessionUsage && sessionUsages && categories.length > 0) {
    const totalSessionUsage = categories.reduce((sum, cat) => sum + (sessionUsages[cat] || 0), 0);
    const avgSessionUsage = Math.round(totalSessionUsage / categories.length);
    if (avgSessionUsage > 0) {
      avgSuffix = ` (-${avgSessionUsage}%)`;
    }
  }

  if (percentage === 0 && countdownSuffix) {
    return `$(rocket)${countdownSuffix}${avgSuffix}`;
  }

  return `$(rocket) ${percentage}%${avgSuffix}`;
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
