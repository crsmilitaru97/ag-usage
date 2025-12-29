import * as vscode from 'vscode';
import { CATEGORY_ORDER, COLOR_THRESHOLDS, MS_PER_HOUR, SETTINGS_COMMAND, SVG_CONFIG, THEME_COLORS } from './constants';
import { formatRemainingTime, formatStatusBarText } from './formatter';
import { QuotaGroup, UsageStatistics } from './types';

const LAYOUT = {
  textYCategory: 21,
  barY: 30,
  barXOffset: 10,
  textYPercentageShadow: 45,
  textYPercentage: 44,
  textYTimer: 77,
  borderRadius: 4,
  footerTextYOffset: 8,
  footerTextXOffset: 10,
  fontFamily: 'sans-serif'
};

const XML_ESCAPES: Record<string, string> = {
  '<': '&lt;',
  '>': '&gt;',
  '&': '&amp;',
  '"': '&quot;',
  "'": '&apos;'
};

function getThemeColors(): { text: string; barBackground: string; textShadow: string } {
  const { kind } = vscode.window.activeColorTheme;
  const isLight = kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight;
  return isLight ? THEME_COLORS.light : THEME_COLORS.dark;
}

function getBarColor(percentage: number): string {
  if (percentage >= COLOR_THRESHOLDS.high.value) { return COLOR_THRESHOLDS.high.color; }
  if (percentage >= COLOR_THRESHOLDS.medium.value) { return COLOR_THRESHOLDS.medium.color; }
  return COLOR_THRESHOLDS.low.color;
}

function escapeXml(unsafe: string): string {
  return unsafe.replace(/[<>&"']/g, c => XML_ESCAPES[c] ?? c);
}

function buildCategorySvg(
  category: string,
  group: QuotaGroup,
  xPosition: number,
  colors: { text: string; barBackground: string; textShadow: string }
): string {
  const { columnWidth, barWidth, barHeight } = SVG_CONFIG;
  const {
    textYCategory,
    barY,
    barXOffset,
    textYPercentageShadow,
    textYPercentage,
    textYTimer,
    borderRadius,
    fontFamily
  } = LAYOUT;

  const centerX = xPosition + columnWidth / 2;
  const clampedQuota = Math.max(0, Math.min(1, group.quota));
  const percentage = Math.round(clampedQuota * 100);
  const barColor = getBarColor(percentage);
  const escapedCategory = escapeXml(category);

  const barX = xPosition + barXOffset;
  const widthPx = (clampedQuota * barWidth).toFixed(1);

  let svg = `
    <text x="${centerX}" y="${textYCategory}" fill="${colors.text}" text-anchor="middle" font-family="${fontFamily}" font-size="12" font-weight="bold">${escapedCategory}</text>
    <rect x="${barX}" y="${barY}" rx="${borderRadius}" width="${barWidth}" height="${barHeight}" fill="${colors.barBackground}"/>
    <rect x="${barX}" y="${barY}" rx="${borderRadius}" width="${widthPx}" height="${barHeight}" fill="${barColor}"/>
    <text x="${centerX}" y="${textYPercentageShadow}" fill="${colors.textShadow}" fill-opacity=".3" text-anchor="middle" font-family="${fontFamily}" font-size="12" font-weight="bold">${percentage}%</text>
    <text x="${centerX}" y="${textYPercentage}" fill="#fff" text-anchor="middle" font-family="${fontFamily}" font-size="12" font-weight="bold">${percentage}%</text>`;

  if (clampedQuota < 1 && typeof group.resetTime === 'number') {
    const { text, diffMs } = formatRemainingTime(group.resetTime);
    const timeColor = diffMs < MS_PER_HOUR ? COLOR_THRESHOLDS.medium.color : colors.text;
    svg += `<text x="${centerX + 2}" y="${textYTimer}" fill="${timeColor}" text-anchor="middle" font-family="${fontFamily}" font-size="13" font-weight="bold">${text} ⏳</text>`;
  }

  return svg;
}

function isValidQuotaGroup(value: unknown): value is QuotaGroup {
  if (typeof value !== 'object' || value === null) { return false; }
  if (!('quota' in value) || !('resetTime' in value)) { return false; }
  const { quota, resetTime } = value as { quota: unknown; resetTime: unknown };
  return typeof quota === 'number' &&
    Number.isFinite(quota) &&
    (resetTime === null || (typeof resetTime === 'number' && Number.isFinite(resetTime)));
}

const MAX_GROUPS_VALIDATION = 100;

function isValidUsageStatistics(data: unknown): data is UsageStatistics {
  if (typeof data !== 'object' || data === null) { return false; }
  if (!('groups' in data)) { return false; }
  const { groups } = data as { groups: unknown };
  if (typeof groups !== 'object' || groups === null) { return false; }

  const groupValues = Object.values(groups);
  if (groupValues.length > MAX_GROUPS_VALIDATION) {
    return false;
  }

  return groupValues.every(isValidQuotaGroup);
}

export function renderStats(data: UsageStatistics, statusBarItem: vscode.StatusBarItem): void {
  if (!isValidUsageStatistics(data)) {
    statusBarItem.text = '$(warning) AG Usage';
    statusBarItem.tooltip = 'Invalid data received from server';
    return;
  }

  const { groups } = data;
  const categories = CATEGORY_ORDER.filter(category => groups[category]);

  const { columnWidth, columnPadding, height } = SVG_CONFIG;
  const totalWidth = categories.length > 0
    ? categories.length * columnWidth + (categories.length - 1) * columnPadding
    : columnWidth;

  const colors = getThemeColors();

  let svgContent = `<svg width="${totalWidth}" height="${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="AG Usage Statistics">`;

  for (let i = 0; i < categories.length; i++) {
    const category = categories[i];
    const group = groups[category];
    if (!group) { continue; }
    const xPosition = i * (columnWidth + columnPadding);
    svgContent += buildCategorySvg(category, group, xPosition, colors);
  }

  const { footerTextXOffset, footerTextYOffset, fontFamily } = LAYOUT;
  const footerX = totalWidth - footerTextXOffset;
  const footerY = height - footerTextYOffset;

  svgContent += `<text x="${footerX}" y="${footerY}" fill="#666" text-anchor="end" font-family="${fontFamily}" font-size="11">Click to refresh. Models are grouped according to how quota is calculated.</text>`;
  svgContent += `</svg>`;

  const md = new vscode.MarkdownString();
  md.appendMarkdown(`<img src="data:image/svg+xml;base64,${Buffer.from(svgContent).toString('base64')}"/>\n\n`);
  md.appendMarkdown(`<div align="center"><a href="command:${SETTINGS_COMMAND}">Open Settings</a></div>`);
  md.isTrusted = true;
  md.supportHtml = true;

  statusBarItem.text = formatStatusBarText(groups, categories);
  statusBarItem.tooltip = md;
}
