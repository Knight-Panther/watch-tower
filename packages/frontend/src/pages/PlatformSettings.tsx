import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import Spinner from "../components/Spinner";
import { useServerEventsContext } from "../contexts/ServerEventsContext";
import {
  listSocialAccounts,
  getSocialAccountsUsage,
  updateSocialAccountRateLimit,
  getAutoPostTelegram,
  setAutoPostTelegram as setAutoPostTelegramApi,
  getAutoPostFacebook,
  setAutoPostFacebook as setAutoPostFacebookApi,
  getAutoPostLinkedin,
  setAutoPostLinkedin as setAutoPostLinkedinApi,
  getPlatformHealth,
  refreshPlatformHealth,
  type SocialAccount,
  type PlatformUsage,
  type PlatformHealth,
} from "../api";

const PLATFORM_ICONS: Record<string, string> = {
  telegram: "📨",
  facebook: "📘",
  linkedin: "💼",
};

const STATUS_COLORS: Record<string, { dot: string; badge: string; text: string }> = {
  active: { dot: "bg-emerald-500", badge: "bg-emerald-500/20 text-emerald-400", text: "Active" },
  expiring: { dot: "bg-amber-500", badge: "bg-amber-500/20 text-amber-400", text: "Expiring" },
  expired: { dot: "bg-red-500", badge: "bg-red-500/20 text-red-400", text: "Expired" },
  error: { dot: "bg-red-500", badge: "bg-red-500/20 text-red-400", text: "Error" },
};

const formatRelativeTime = (isoString: string): string => {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
};

const PLATFORM_DESCRIPTIONS: Record<string, string> = {
  telegram: "Post to connected Telegram channel",
  facebook: "Post to connected Facebook page",
  linkedin: "Post to connected LinkedIn page",
};

export default function PlatformSettings() {
  const [isLoading, setIsLoading] = useState(true);
  const [accounts, setAccounts] = useState<SocialAccount[]>([]);
  const [platformUsage, setPlatformUsage] = useState<Record<string, PlatformUsage>>({});

  // Auto-post toggle states
  const [autoPostTelegram, setAutoPostTelegram] = useState(true);
  const [isAutoPostTelegramLoading, setIsAutoPostTelegramLoading] = useState(false);
  const [autoPostFacebook, setAutoPostFacebook] = useState(false);
  const [isAutoPostFacebookLoading, setIsAutoPostFacebookLoading] = useState(false);
  const [autoPostLinkedin, setAutoPostLinkedin] = useState(false);
  const [isAutoPostLinkedinLoading, setIsAutoPostLinkedinLoading] = useState(false);

  // Rate limit draft values (for editing)
  const [rateLimitDrafts, setRateLimitDrafts] = useState<Record<string, string>>({});
  const [savingRateLimit, setSavingRateLimit] = useState<string | null>(null);

  // Platform health state
  const [platformHealth, setPlatformHealth] = useState<PlatformHealth[]>([]);
  const [isHealthLoading, setIsHealthLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Load data on mount
  useEffect(() => {
    const loadData = async () => {
      try {
        const [
          accountsData,
          usageData,
          telegramEnabled,
          facebookEnabled,
          linkedinEnabled,
        ] = await Promise.all([
          listSocialAccounts(),
          getSocialAccountsUsage(),
          getAutoPostTelegram(),
          getAutoPostFacebook(),
          getAutoPostLinkedin(),
        ]);

        setAccounts(accountsData);
        const byPlatform = Object.fromEntries(usageData.usage.map((u) => [u.platform, u]));
        setPlatformUsage(byPlatform);
        setAutoPostTelegram(telegramEnabled);
        setAutoPostFacebook(facebookEnabled);
        setAutoPostLinkedin(linkedinEnabled);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to load platform settings";
        toast.error(message);
      } finally {
        setIsLoading(false);
      }
    };
    loadData();

    // Load health separately (non-blocking)
    const loadHealth = async () => {
      try {
        const health = await getPlatformHealth();
        setPlatformHealth(health);
      } catch {
        // Silent fail - health section optional
      } finally {
        setIsHealthLoading(false);
      }
    };
    loadHealth();
  }, []);

  // SSE: refresh usage when a post goes out (usage counters change)
  const { subscribe } = useServerEventsContext();

  const loadUsage = useCallback(async () => {
    try {
      const { usage } = await getSocialAccountsUsage();
      const byPlatform = Object.fromEntries(usage.map((u) => [u.platform, u]));
      setPlatformUsage(byPlatform);
    } catch {
      // Silent fail
    }
  }, []);

  useEffect(() => {
    const unsubscribe = subscribe(["article:posted"], loadUsage);
    return unsubscribe;
  }, [subscribe, loadUsage]);

  const handleTelegramToggle = useCallback(async () => {
    setIsAutoPostTelegramLoading(true);
    try {
      const newValue = !autoPostTelegram;
      await setAutoPostTelegramApi(newValue);
      setAutoPostTelegram(newValue);
      toast.success(`Telegram auto-post ${newValue ? "enabled" : "disabled"}`);
    } catch {
      toast.error("Failed to update Telegram setting");
    } finally {
      setIsAutoPostTelegramLoading(false);
    }
  }, [autoPostTelegram]);

  const handleFacebookToggle = useCallback(async () => {
    setIsAutoPostFacebookLoading(true);
    try {
      const newValue = !autoPostFacebook;
      await setAutoPostFacebookApi(newValue);
      setAutoPostFacebook(newValue);
      toast.success(`Facebook auto-post ${newValue ? "enabled" : "disabled"}`);
    } catch {
      toast.error("Failed to update Facebook setting");
    } finally {
      setIsAutoPostFacebookLoading(false);
    }
  }, [autoPostFacebook]);

  const handleLinkedinToggle = useCallback(async () => {
    setIsAutoPostLinkedinLoading(true);
    try {
      const newValue = !autoPostLinkedin;
      await setAutoPostLinkedinApi(newValue);
      setAutoPostLinkedin(newValue);
      toast.success(`LinkedIn auto-post ${newValue ? "enabled" : "disabled"}`);
    } catch {
      toast.error("Failed to update LinkedIn setting");
    } finally {
      setIsAutoPostLinkedinLoading(false);
    }
  }, [autoPostLinkedin]);

  const handleRefreshHealth = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await refreshPlatformHealth();
      toast.info("Health check queued - refreshing in 5s...");
      setTimeout(async () => {
        try {
          const health = await getPlatformHealth();
          setPlatformHealth(health);
        } catch {
          // Ignore
        }
        setIsRefreshing(false);
      }, 5000);
    } catch {
      toast.error("Failed to refresh health");
      setIsRefreshing(false);
    }
  }, []);

  const getToggleHandler = (platform: string) => {
    switch (platform) {
      case "telegram":
        return handleTelegramToggle;
      case "facebook":
        return handleFacebookToggle;
      case "linkedin":
        return handleLinkedinToggle;
      default:
        return () => {};
    }
  };

  const getToggleState = (platform: string) => {
    switch (platform) {
      case "telegram":
        return { enabled: autoPostTelegram, loading: isAutoPostTelegramLoading };
      case "facebook":
        return { enabled: autoPostFacebook, loading: isAutoPostFacebookLoading };
      case "linkedin":
        return { enabled: autoPostLinkedin, loading: isAutoPostLinkedinLoading };
      default:
        return { enabled: false, loading: false };
    }
  };

  const handleRateLimitSave = async (accountId: string, platform: string) => {
    const draftValue = rateLimitDrafts[accountId];
    if (!draftValue) return;

    const value = parseInt(draftValue, 10);
    if (isNaN(value) || value < 1 || value > 100) {
      toast.error("Rate limit must be between 1 and 100");
      return;
    }

    setSavingRateLimit(accountId);
    try {
      await updateSocialAccountRateLimit(accountId, value);
      setAccounts((prev) =>
        prev.map((a) => (a.id === accountId ? { ...a, rate_limit_per_hour: value } : a)),
      );
      setRateLimitDrafts((prev) => {
        const next = { ...prev };
        delete next[accountId];
        return next;
      });
      toast.success(`${platform} rate limit updated to ${value}/hr`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update rate limit";
      toast.error(message);
    } finally {
      setSavingRateLimit(null);
    }
  };

  const UsageIndicator = ({ platform }: { platform: string }) => {
    const usage = platformUsage[platform];
    if (!usage) return null;

    const statusColors = {
      ok: "text-emerald-400",
      warning: "text-amber-400",
      blocked: "text-red-400",
    };

    return (
      <span className={`text-xs ${statusColors[usage.status]}`}>
        {usage.current}/{usage.limit}/hr
        {usage.status === "blocked" && " (limit reached)"}
      </span>
    );
  };

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Platform Settings</h1>
        <p className="mt-1 text-sm text-slate-400">
          Configure auto-posting behavior and rate limits for each platform.
        </p>
      </div>

      {/* Top Row: Connection Status + Rate Limits side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Connection Status Section */}
        <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Connection Status</h2>
            <p className="mt-1 text-sm text-slate-400">
              Token validity and platform API health
            </p>
          </div>
          <button
            onClick={handleRefreshHealth}
            disabled={isRefreshing}
            className="rounded-lg border border-slate-700 px-3 py-2 text-sm hover:border-slate-500 disabled:opacity-50"
          >
            {isRefreshing ? "Checking..." : "Refresh"}
          </button>
        </div>

        <div className="mt-6 space-y-4">
          {isHealthLoading && (
            <p className="text-sm text-slate-500">Loading health status...</p>
          )}
          {!isHealthLoading && platformHealth.length === 0 && (
            <p className="text-sm text-slate-500">
              No health data yet. Click Refresh to check platform status.
            </p>
          )}
          {platformHealth.map((health) => {
            const icon = PLATFORM_ICONS[health.platform] ?? "📱";
            const statusStyle = STATUS_COLORS[health.status] ?? STATUS_COLORS.error;
            const lastCheckRelative = formatRelativeTime(health.lastCheck);
            const lastPostRelative = health.lastPost ? formatRelativeTime(health.lastPost) : null;

            // Token expiry info
            const getExpiryInfo = () => {
              if (health.status === "error") return null;
              if (health.expiresAt) {
                const days = health.daysRemaining ?? 0;
                if (days <= 0) return { text: "Token expired", urgent: true };
                if (days <= 7) return { text: `Expires in ${days}d`, urgent: true };
                if (days <= 14) return { text: `Expires in ${days}d`, urgent: false };
                return { text: `Expires in ${days}d`, urgent: false };
              }
              // Telegram tokens never expire, FB long-lived page tokens may not have expiry
              if (health.platform === "telegram") return { text: "Never expires", urgent: false };
              return null; // Don't show anything if no expiry info
            };

            const expiryInfo = getExpiryInfo();

            return (
              <div
                key={health.platform}
                className="flex items-center justify-between rounded-xl border border-slate-700 bg-slate-950 px-4 py-4"
              >
                <div className="flex items-center gap-4">
                  <span className="text-2xl">{icon}</span>
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-slate-200 capitalize">{health.platform}</p>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusStyle.badge}`}>
                        {statusStyle.text}
                      </span>
                      <span className="text-xs text-slate-600">· {lastCheckRelative}</span>
                    </div>
                    {health.status === "error" ? (
                      <p className="mt-0.5 text-xs text-red-400 max-w-xs truncate" title={health.error ?? "Unknown error"}>
                        {health.error ?? "Unknown error"}
                      </p>
                    ) : (
                      <p className="mt-0.5 text-xs text-slate-500">
                        {PLATFORM_DESCRIPTIONS[health.platform] || "Social platform"}
                      </p>
                    )}
                  </div>
                </div>

                <div className="text-right text-xs space-y-0.5">
                  {/* Token expiry */}
                  {expiryInfo && (
                    <p className={expiryInfo.urgent ? "text-amber-400 font-medium" : "text-slate-400"}>
                      {expiryInfo.text}
                    </p>
                  )}

                  {/* API rate limits from platform */}
                  {health.rateLimit.remaining !== null && health.rateLimit.limit !== null && (
                    <p className="text-slate-400">
                      API: {health.rateLimit.remaining}/{health.rateLimit.limit} calls left
                    </p>
                  )}
                  {health.rateLimit.percent !== null && (
                    <p className={health.rateLimit.percent > 80 ? "text-amber-400" : "text-slate-400"}>
                      API load: {health.rateLimit.percent}%
                    </p>
                  )}

                  {/* Last post */}
                  {lastPostRelative && (
                    <p className="text-slate-500">Last post: {lastPostRelative}</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

        {/* Rate Limits Section */}
        <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
          <h2 className="text-lg font-semibold">Rate Limits</h2>
          <p className="mt-1 text-sm text-slate-400">
            Posts per hour limit for each platform.
          </p>

          <div className="mt-6 space-y-4">
            {accounts.map((account) => {
              const draftValue = rateLimitDrafts[account.id];
              const currentValue = draftValue ?? String(account.rate_limit_per_hour);
              const hasChanges = draftValue !== undefined && draftValue !== String(account.rate_limit_per_hour);
              const isSaving = savingRateLimit === account.id;

              return (
                <div
                  key={account.id}
                  className="flex items-center justify-between rounded-xl border border-slate-700 bg-slate-950 px-4 py-4"
                >
                  <div className="flex items-center gap-4">
                    <span className="text-2xl">{PLATFORM_ICONS[account.platform] || "📱"}</span>
                    <div>
                      <p className="font-medium text-slate-200">
                        {account.platform.charAt(0).toUpperCase() + account.platform.slice(1)}
                      </p>
                      <UsageIndicator platform={account.platform} />
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={currentValue}
                      onChange={(e) =>
                        setRateLimitDrafts((prev) => ({
                          ...prev,
                          [account.id]: e.target.value,
                        }))
                      }
                      className="w-16 rounded-lg border border-slate-700 bg-slate-900 px-2 py-2 text-sm text-slate-200 outline-none focus:border-slate-500"
                    />
                    <span className="text-xs text-slate-400">/hr</span>
                    {hasChanges && (
                      <button
                        onClick={() => handleRateLimitSave(account.id, account.platform)}
                        disabled={isSaving}
                        className="rounded-lg bg-emerald-600 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                      >
                        {isSaving ? "..." : "Save"}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <p className="mt-4 text-xs text-slate-500">
            Recommended: Telegram 20, Facebook 1, LinkedIn 4
          </p>
        </section>
      </div>

      {/* Bottom Row: Auto-Post Settings (full width) */}
      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
        <h2 className="text-lg font-semibold">Auto-Post Settings</h2>
        <p className="mt-1 text-sm text-slate-400">
          When enabled, articles meeting the auto-approve threshold will be posted automatically.
        </p>

        <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4">
          {accounts.map((account) => {
            const { enabled, loading } = getToggleState(account.platform);
            const toggleHandler = getToggleHandler(account.platform);

            return (
              <div
                key={account.id}
                className="flex items-center justify-between rounded-xl border border-slate-700 bg-slate-950 px-4 py-4"
              >
                <div className="flex items-center gap-3">
                  <span className="text-2xl">{PLATFORM_ICONS[account.platform] || "📱"}</span>
                  <div>
                    <p className="font-medium text-slate-200">
                      {account.platform.charAt(0).toUpperCase() + account.platform.slice(1)}
                    </p>
                    <UsageIndicator platform={account.platform} />
                  </div>
                </div>
                <button
                  onClick={toggleHandler}
                  disabled={loading}
                  className={`relative h-7 w-12 rounded-full transition-colors ${
                    enabled ? "bg-emerald-500" : "bg-slate-600"
                  } ${loading ? "opacity-50" : ""}`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 h-6 w-6 rounded-full bg-white transition-transform ${
                      enabled ? "translate-x-5" : "translate-x-0"
                    }`}
                  />
                </button>
              </div>
            );
          })}
        </div>
      </section>

    </div>
  );
}
