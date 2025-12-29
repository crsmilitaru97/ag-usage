export const CONFIG_NAMESPACE = 'ag-usage';
export const REFRESH_COMMAND = 'ag-usage.refresh';
export const SETTINGS_COMMAND = 'ag-usage.openSettings';
export const INITIAL_DELAY_MS = 1500;
export const MIN_DISPLAY_DELAY_MS = 300;
export const STATUS_BAR_PRIORITY = 100;
export const DEFAULT_REFRESH_INTERVAL = 60;
export const MS_PER_SECOND = 1000;
export const MS_PER_MINUTE = 60000;
export const MS_PER_HOUR = 3600000;
export const MS_PER_DAY = 86400000;
export const CACHE_TTL_MS = 300000;
export const REQUEST_TIMEOUT_MS = 2500;
export const RETRY_DELAY_MS = 150;
export const MAX_VALID_PID = 0x7FFFFFFF;
export const MIN_PORT = 1;
export const MAX_PORT = 65535;
export const FAILED_REFRESH_DELAY_MS = 5000;
export const MAX_FAILED_REFRESH_DELAY_MS = 60000;
export const MAX_STATUS_TEXT_LENGTH = 40;
export const MAX_PORT_VALIDATION_ATTEMPTS = 2;

export const PROCESS_IDENTIFIERS = {
  LANGUAGE_SERVER: 'language_server',
  ANTIGRAVITY: 'antigravity',
  CSRF_TOKEN: '--csrf_token'
};

export const IDE_INFO = {
  NAME: 'antigravity',
  VERSION: '1.0.0'
};

export const SVG_CONFIG = {
  columnWidth: 120,
  columnPadding: 10,
  barWidth: 100,
  barHeight: 20,
  height: 115
};

export const COLOR_THRESHOLDS = {
  high: { value: 65, color: '#449d44' },
  medium: { value: 25, color: '#ec971f' },
  low: { color: '#c9302c' }
};

export const THEME_COLORS = {
  light: { text: '#333', barBackground: '#ddd', textShadow: '#666' },
  dark: { text: '#ccc', barBackground: '#555', textShadow: '#010101' }
};

export const CATEGORY_NAMES = {
  GEMINI_PRO: 'Gemini 3 Pro',
  GEMINI_FLASH: 'Gemini 3 Flash',
  CLAUDE_GPT: 'Claude/GPT'
} as const;

export const CATEGORY_ORDER = [CATEGORY_NAMES.GEMINI_PRO, CATEGORY_NAMES.GEMINI_FLASH, CATEGORY_NAMES.CLAUDE_GPT];

export const DISPLAY_MODE_TO_CATEGORY: Record<string, string> = {
  geminiPro: CATEGORY_NAMES.GEMINI_PRO,
  geminiFlash: CATEGORY_NAMES.GEMINI_FLASH,
  claudeGpt: CATEGORY_NAMES.CLAUDE_GPT
};

export const SHORT_NAMES: Record<string, string> = {
  [CATEGORY_NAMES.GEMINI_PRO]: 'Pro',
  [CATEGORY_NAMES.GEMINI_FLASH]: 'Flash',
  [CATEGORY_NAMES.CLAUDE_GPT]: 'C/G'
};

export const MODEL_KEYWORDS = {
  flash: 'flash',
  gemini: 'gemini'
};
