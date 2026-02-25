import * as vscode from 'vscode';
import { CONFIG_NAMESPACE } from './constants';

export interface QuotaHistoryEntry {
  category: string;
  previousQuota: number;
  currentQuota: number;
  delta: number;
  timestamp: number;
  resetTime: number | null;
  isInitial?: boolean;
}

export class QuotaHistory {
  private entries: QuotaHistoryEntry[] = [];
  private previousQuotas: Record<string, number> = {};

  constructor(initialEntries: QuotaHistoryEntry[] = []) {
    this.entries = [...initialEntries];

    this.prune();

    const entriesByCategory: Record<string, QuotaHistoryEntry> = {};
    for (const entry of this.entries) {
      if (!entriesByCategory[entry.category] || entry.timestamp > entriesByCategory[entry.category].timestamp) {
        entriesByCategory[entry.category] = entry;
      }
    }

    for (const [category, entry] of Object.entries(entriesByCategory)) {
      this.previousQuotas[category] = entry.currentQuota;
    }
  }

  getEntries(): ReadonlyArray<QuotaHistoryEntry> {
    return this.entries;
  }

  getRawEntries(): QuotaHistoryEntry[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries = [];
    this.previousQuotas = {};
  }

  public prune() {
    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    const maxHistoryItems = config.get<number>('maxHistoryItems', 10);
    const enableHistoryTracking = config.get<boolean>('enableHistoryTracking', true);

    if (!enableHistoryTracking) {
      this.entries = [];
      return;
    }

    const counts: Record<string, number> = {};
    const filteredEntries: QuotaHistoryEntry[] = [];

    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      counts[entry.category] = (counts[entry.category] || 0) + 1;
      if (counts[entry.category] <= maxHistoryItems) {
        filteredEntries.unshift(entry);
      }
    }

    this.entries = filteredEntries;
  }

  recordSnapshot(groups: Record<string, { quota: number; resetTime: number | null }>): QuotaHistoryEntry[] {
    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    const enableHistoryTracking = config.get<boolean>('enableHistoryTracking', true);

    const newEntries: QuotaHistoryEntry[] = [];
    const now = Date.now();

    for (const [category, group] of Object.entries(groups)) {
      const previous = this.previousQuotas[category];

      if (previous === group.quota) {
        continue;
      }

      const isInitial = previous === undefined;
      const entry: QuotaHistoryEntry = {
        category,
        previousQuota: isInitial ? group.quota : previous,
        currentQuota: group.quota,
        delta: isInitial ? 0 : group.quota - previous,
        timestamp: now,
        resetTime: group.resetTime,
        isInitial: isInitial ? true : undefined
      };

      if (enableHistoryTracking) {
        newEntries.push(entry);
      }
      this.previousQuotas[category] = group.quota;
    }

    if (newEntries.length > 0) {
      this.entries.push(...newEntries);
    }

    this.prune();

    return newEntries;
  }
}
