import * as vscode from 'vscode';
import { CATEGORY_ORDER, COLOR_THRESHOLDS, EXTENSION_TITLE, MS_PER_MINUTE, SETTINGS_COMMAND, SVG_CONFIG, THEME_COLORS } from './constants';
import { formatRelativeTime, formatRemainingTimeSeparate, formatStatusBarText } from './formatter';
import { QuotaGroup, SessionQuotaTracker, UsageStatistics } from './types';

const LAYOUT = {
  cardPadding: 5,
  cardRadius: 10,
  textYCategory: 18,
  textYPercent: 42,
  barY: 59,
  barHeight: 5,
  barRadius: 2.5,
  textStyle: 'text-anchor="middle" dominant-baseline="middle" font-family="system-ui, sans-serif"'
};

const LAYOUT_FULL = {
  cardHeight: 132,
  svgHeight: 142,
  textYSession: 78,
  separatorY: 92,
  textYTime: 115
};

const LAYOUT_COMPACT = {
  cardHeight: 104,
  svgHeight: 112,
  separatorY: 74,
  textYTime: 86
};

const OPACITY = {
  veryLow: 0.15,
  medium: 0.5,
  high: 0.75
};

const XML_ESCAPES: Record<string, string> = {
  '<': '&lt;',
  '>': '&gt;',
  '&': '&amp;',
  '"': '&quot;',
  "'": '&apos;'
};

const MAX_GROUPS_VALIDATION = 100;
const SESSION_THRESHOLD_LOW = 10;
const SESSION_THRESHOLD_MEDIUM = 40;

interface ThemeColors {
  text: string;
  barBackground: string;
  cardFill: string;
  cardBorder: string;
  success: string;
  warning: string;
  error: string;
}

interface CategorySvgOptions {
  category: string;
  group: QuotaGroup;
  xPosition: number;
  colors: ThemeColors;
  hasSession: boolean;
  isPerWindow: boolean;
  sessionConsumed?: number;
  sessionElapsedMs?: number;
}

function getThemeColors(): ThemeColors {
  const { kind } = vscode.window.activeColorTheme;
  const isLight = kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight;
  return isLight ? THEME_COLORS.light : THEME_COLORS.dark;
}

function getBarColor(percentage: number, colors: ThemeColors): string {
  const { high, medium } = COLOR_THRESHOLDS;
  if (percentage >= high.value) return colors.success;
  if (percentage >= medium.value) return colors.warning;
  return colors.error;
}

function getSessionColor(consumed: number, colors: ThemeColors): string {
  if (consumed <= SESSION_THRESHOLD_LOW) return colors.success;
  if (consumed <= SESSION_THRESHOLD_MEDIUM) return colors.warning;
  return colors.error;
}

function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, char => XML_ESCAPES[char] ?? char);
}

function isValidQuotaGroup(value: unknown): value is QuotaGroup {
  if (!value || typeof value !== 'object') { return false; }
  const g = value as Record<string, unknown>;
  return typeof g.quota === 'number' && Number.isFinite(g.quota) &&
    (g.resetTime === null || (typeof g.resetTime === 'number' && Number.isFinite(g.resetTime)));
}

function buildClockSvg(centerX: number, clockY: number, color: string, opacity: number): string {
  return `
    <circle cx="${centerX}" cy="${clockY}" r="7" stroke="${color}" stroke-width="1.5" fill="none" opacity="${opacity}"/>
    <line x1="${centerX}" y1="${clockY}" x2="${centerX}" y2="${clockY - 4.5}" stroke="${color}" stroke-width="1.5" stroke-linecap="round" opacity="${opacity}">
      <animateTransform attributeName="transform" type="rotate" from="0 ${centerX} ${clockY}" to="360 ${centerX} ${clockY}" dur="12s" repeatCount="indefinite" />
    </line>
    <line x1="${centerX}" y1="${clockY}" x2="${centerX + 3}" y2="${clockY}" stroke="${color}" stroke-width="1.5" stroke-linecap="round" opacity="${opacity}">
      <animateTransform attributeName="transform" type="rotate" from="0 ${centerX} ${clockY}" to="360 ${centerX} ${clockY}" dur="144s" repeatCount="indefinite" />
    </line>`;
}

function buildCountdownSvg(centerX: number, y: number, relative: string, absolute: string | null, color: string): string {
  if (!absolute) {
    return `<text x="${centerX}" y="${y}" fill="${color}" fill-opacity="${OPACITY.high}" ${LAYOUT.textStyle} font-size="14" font-weight="600">${relative}</text>`;
  }
  return `
    <text x="${centerX}" y="${y - 5}" fill="${color}" fill-opacity="${OPACITY.high}" ${LAYOUT.textStyle} font-size="13" font-weight="600">${relative}</text>
    <text x="${centerX}" y="${y + 11}" fill="${color}" fill-opacity="${OPACITY.medium}" ${LAYOUT.textStyle} font-size="10" font-weight="500">${absolute}</text>`;
}

function buildTimeLeftSvg(centerX: number, y: number, timer: ReturnType<typeof formatRemainingTimeSeparate>, colors: ThemeColors): string {
  const color = timer.diffMs < 10 * MS_PER_MINUTE ? colors.success : colors.text;
  return buildCountdownSvg(centerX, y, escapeXml(timer.relativeText), timer.absoluteText ? escapeXml(timer.absoluteText) : null, color);
}

function buildZeroPercentState(centerX: number, centerY: number, resetTime: number, colors: ThemeColors): string {
  const timer = formatRemainingTimeSeparate(resetTime);
  const color = timer.diffMs < 10 * MS_PER_MINUTE ? colors.success : colors.text;
  const clockY = timer.absoluteText ? centerY - 20 : centerY - 15;
  return buildClockSvg(centerX, clockY, color, OPACITY.medium) + buildTimeLeftSvg(centerX, centerY + 15, timer, colors);
}

function buildSessionInfoSvg(centerX: number, y: number, consumed: number, elapsedMs: number | undefined, isPerWindow: boolean, colors: ThemeColors): string {
  const color = getSessionColor(consumed, colors);
  const elapsedText = elapsedMs ? formatRelativeTime(elapsedMs) : '';
  const isZero = consumed === 0 && (!elapsedMs || elapsedMs < 60000);
  const windowIcon = isPerWindow ? ' ▣' : '';

  const percentText = escapeXml(isZero ? '↓ -' : `↓ ${consumed}%`);
  const timeText = escapeXml(isZero ? windowIcon : ` in ${elapsedText}${windowIcon}`);

  return `
    <text x="${centerX}" y="${y}" ${LAYOUT.textStyle} font-size="11.25" font-weight="500">
      <tspan fill="${color}">${percentText}</tspan>
      <tspan fill="${colors.text}" fill-opacity="${OPACITY.medium}">${timeText}</tspan>
    </text>`;
}

function buildProgressBarSvg(centerX: number, textYPercent: number, percentage: number, barColor: string, barY: number, barWidth: number, barHeight: number, barRadius: number, barBackground: string): string {
  const barX = centerX - (barWidth / 2);
  const filledWidth = ((percentage / 100) * barWidth).toFixed(1);
  return `
    <text x="${centerX}" y="${textYPercent}" fill="${barColor}" ${LAYOUT.textStyle} font-size="18" font-weight="700">${percentage}%</text>
    <rect x="${barX}" y="${barY}" rx="${barRadius}" width="${barWidth}" height="${barHeight}" fill="${barBackground}"/>
    <rect x="${barX}" y="${barY}" rx="${barRadius}" width="${filledWidth}" height="${barHeight}" fill="${barColor}"/>`;
}

function buildSeparatorSvg(centerX: number, y: number, color: string): string {
  return `<line x1="${centerX - 17}" y1="${y}" x2="${centerX + 17}" y2="${y}" stroke="${color}" stroke-opacity="${OPACITY.veryLow}" stroke-width="1"/>`;
}

function isValidUsageStatistics(data: unknown): data is UsageStatistics {
  if (!data || typeof data !== 'object') { return false; }
  const d = data as Record<string, unknown>;
  if (!d.groups || typeof d.groups !== 'object') { return false; }
  const groupValues = Object.values(d.groups);
  return groupValues.length <= MAX_GROUPS_VALIDATION && groupValues.every(isValidQuotaGroup);
}

function buildCategorySvg(options: CategorySvgOptions): string {
  const { category, group, xPosition, colors, hasSession, isPerWindow, sessionConsumed, sessionElapsedMs } = options;
  const { columnWidth, barWidth } = SVG_CONFIG;
  const { cardPadding, cardRadius, textYCategory, textYPercent, barY, barHeight, barRadius } = LAYOUT;
  const { cardHeight, separatorY, textYTime } = hasSession ? LAYOUT_FULL : LAYOUT_COMPACT;

  const centerX = xPosition + columnWidth / 2;
  const percentage = Math.round(Math.max(0, Math.min(1, group.quota)) * 100);
  const barColor = getBarColor(percentage, colors);
  const label = escapeXml(category).toUpperCase();

  const cardX = xPosition + cardPadding;
  const cardW = columnWidth - (cardPadding * 2);

  let svg = `
    <rect x="${cardX}" y="${cardPadding}" rx="${cardRadius}" width="${cardW}" height="${cardHeight}" fill="${colors.cardFill}" stroke="${colors.cardBorder}" stroke-width="1"/>
    <text x="${centerX}" y="${textYCategory}" fill="${colors.text}" fill-opacity="${OPACITY.high}" ${LAYOUT.textStyle} font-size="9" font-weight="500" letter-spacing="0.5">${label}</text>`;

  if (percentage === 0 && typeof group.resetTime === 'number') {
    return svg + buildZeroPercentState(centerX, cardPadding + cardHeight / 2, group.resetTime, colors);
  }

  svg += buildProgressBarSvg(centerX, textYPercent, percentage, barColor, barY, barWidth, barHeight, barRadius, colors.barBackground);

  if (hasSession && sessionConsumed !== undefined) {
    svg += buildSessionInfoSvg(centerX, LAYOUT_FULL.textYSession, sessionConsumed, sessionElapsedMs, isPerWindow, colors);
    if (percentage >= 100 || typeof group.resetTime === 'number') {
      svg += buildSeparatorSvg(centerX, separatorY, colors.text);
    }
  }

  if (percentage >= 100) {
    svg += `<text x="${centerX}" y="${textYTime}" fill="${colors.text}" fill-opacity="${OPACITY.medium}" ${LAYOUT.textStyle} font-size="12" font-weight="500">Not started</text>`;
  } else if (typeof group.resetTime === 'number') {
    svg += buildTimeLeftSvg(centerX, textYTime, formatRemainingTimeSeparate(group.resetTime), colors);
  }

  return svg;
}

function buildSvgContent(categories: string[], groups: Record<string, QuotaGroup>, hasSession: boolean, isPerWindow: boolean, sessionUsages?: Record<string, number> | null, sessionElapsedMs?: number): string {
  const { columnWidth, columnPadding } = SVG_CONFIG;
  const colors = getThemeColors();
  const svgHeight = hasSession ? LAYOUT_FULL.svgHeight : LAYOUT_COMPACT.svgHeight;
  const totalWidth = categories.length > 0
    ? categories.length * columnWidth + (categories.length - 1) * columnPadding
    : columnWidth;

  let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${totalWidth}" height="${svgHeight}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${EXTENSION_TITLE} Statistics">`;

  categories.forEach((category, index) => {
    const group = groups[category];
    if (group) {
      const xPosition = index * (columnWidth + columnPadding);
      const sessionConsumed = sessionUsages?.[category];
      const elapsedMs = sessionConsumed !== undefined ? sessionElapsedMs : undefined;
      svg += buildCategorySvg({
        category,
        group,
        xPosition,
        colors,
        hasSession,
        isPerWindow,
        sessionConsumed,
        sessionElapsedMs: elapsedMs
      });
    }
  });

  svg += '</svg>';
  return svg;
}

function calculatePerCategorySessionUsage(groups: Record<string, QuotaGroup>, sessionTracker: SessionQuotaTracker | null): Record<string, number> | null {
  if (!sessionTracker) { return null; }

  const result: Record<string, number> = {};
  const entries = Object.entries(sessionTracker.cumulativeConsumed);

  for (const [category, raw] of entries) {
    const baseline = sessionTracker.focusBaseline?.[category];
    const group = groups[category];
    const focusConsumed = (baseline !== undefined && group) ? Math.max(0, baseline - group.quota) : 0;
    result[category] = Math.round((raw + focusConsumed) * 100);
  }

  return entries.length > 0 ? result : null;
}

export function renderStats(data: UsageStatistics, sessionTracker: SessionQuotaTracker | null, isPerWindow: boolean): { text: string; tooltip: vscode.MarkdownString } {
  if (!isValidUsageStatistics(data)) {
    return {
      text: `$(warning) ${EXTENSION_TITLE}`,
      tooltip: new vscode.MarkdownString('Invalid data received from server.')
    };
  }

  const { groups } = data;
  const categories = CATEGORY_ORDER.filter(category => groups[category]);
  const hasSession = sessionTracker !== null;
  const sessionUsages = calculatePerCategorySessionUsage(groups, sessionTracker);
  const sessionElapsedMs = sessionTracker ? Date.now() - sessionTracker.sessionStartTime : undefined;
  const svgContent = buildSvgContent(categories, groups, hasSession, isPerWindow, sessionUsages, sessionElapsedMs);

  const tooltip = new vscode.MarkdownString();
  tooltip.appendMarkdown(`<img src="data:image/svg+xml;base64,${Buffer.from(svgContent).toString('base64')}"/>\n\n`);
  tooltip.appendMarkdown(`<div align="center"><a href="command:${SETTINGS_COMMAND}">Configure Settings</a></div>`);
  tooltip.isTrusted = true;
  tooltip.supportHtml = true;

  return {
    text: formatStatusBarText(groups, categories, sessionUsages),
    tooltip
  };
}
