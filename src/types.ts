export interface QuotaGroup {
  quota: number;
  resetTime: number | null;
}

export interface CachedConnection {
  port: number;
  csrfToken: string;
  timestamp: number;
}

export interface UsageStatistics {
  groups: Record<string, QuotaGroup>;
}

export type ProcessId = number;

export interface ProcessInfo {
  pid: ProcessId;
  cmd: string;
}

export type StatusBarDisplayMode = 'average' | 'all' | 'geminiPro' | 'geminiFlash' | 'claudeGpt';

export interface QuotaInfo {
  remainingFraction?: number;
  resetTime?: string;
}

export interface ModelConfig {
  label: string;
  quotaInfo?: QuotaInfo;
}

export interface ServerUserStatusResponse {
  userStatus?: {
    cascadeModelConfigData?: { clientModelConfigs: ModelConfig[] };
  };
}
