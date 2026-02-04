import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import Spinner from "../components/Spinner";
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
  type SocialAccount,
  type PlatformUsage,
} from "../api";

const PLATFORM_ICONS: Record<string, string> = {
  telegram: "📨",
  facebook: "📘",
  linkedin: "💼",
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

  // Load data on mount
  useEffect(() => {
    const loadData = async () => {
      try {
        const [accountsData, usageData, telegramEnabled, facebookEnabled, linkedinEnabled] =
          await Promise.all([
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
  }, []);

  // Refresh usage periodically
  useEffect(() => {
    const loadUsage = async () => {
      try {
        const { usage } = await getSocialAccountsUsage();
        const byPlatform = Object.fromEntries(usage.map((u) => [u.platform, u]));
        setPlatformUsage(byPlatform);
      } catch {
        // Silent fail
      }
    };
    const interval = setInterval(loadUsage, 30000);
    return () => clearInterval(interval);
  }, []);

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
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Platform Settings</h1>
        <p className="mt-1 text-sm text-slate-400">
          Configure auto-posting behavior and rate limits for each platform.
        </p>
      </div>

      {/* Auto-Post Section */}
      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
        <h2 className="text-lg font-semibold">Auto-Post Settings</h2>
        <p className="mt-1 text-sm text-slate-400">
          When enabled, articles meeting the auto-approve threshold will be posted automatically.
        </p>

        <div className="mt-6 space-y-4">
          {accounts.map((account) => {
            const { enabled, loading } = getToggleState(account.platform);
            const toggleHandler = getToggleHandler(account.platform);

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
                    <p className="text-xs text-slate-500">
                      {PLATFORM_DESCRIPTIONS[account.platform] || account.account_name}
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

      {/* Rate Limits Section */}
      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
        <h2 className="text-lg font-semibold">Rate Limits</h2>
        <p className="mt-1 text-sm text-slate-400">
          Control how many posts per hour are allowed for each platform.
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
                <div className="flex items-center gap-3">
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
                    className="w-20 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-500"
                  />
                  <span className="text-sm text-slate-400">/ hour</span>
                  {hasChanges && (
                    <button
                      onClick={() => handleRateLimitSave(account.id, account.platform)}
                      disabled={isSaving}
                      className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
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
          Recommended limits: Telegram 20/hr, Facebook 1/hr, LinkedIn 4/hr
        </p>
      </section>
    </div>
  );
}
