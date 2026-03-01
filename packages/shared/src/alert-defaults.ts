/**
 * Single source of truth for alert rule defaults.
 * Used by: DB schema (column defaults), API (GET /alerts/defaults), frontend (create form).
 */
export const ALERT_RULE_DEFAULTS = {
  min_score: 4,
  language: "en" as "en" | "ka",
  active: true,
  template: {
    showUrl: true,
    showSummary: true,
    showScore: true,
    showSector: true,
    alertEmoji: "\uD83D\uDD14",
  },
} as const;

export type AlertRuleDefaults = typeof ALERT_RULE_DEFAULTS;
