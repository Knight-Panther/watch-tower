/**
 * Provider balance information returned by balance APIs.
 */
export type ProviderBalance = {
  provider: string;
  available: boolean;
  currency: string;
  totalBalance: number | null; // null if API doesn't support balance check
  grantedBalance?: number; // Promotional/free credits
  toppedUpBalance?: number; // Paid credits
  error?: string; // Error message if fetch failed
};

/**
 * Balance fetcher function signature.
 * Returns null if the provider doesn't support balance checking.
 */
export type BalanceFetcher = (apiKey: string) => Promise<ProviderBalance | null>;

/**
 * Registry entry for a provider's balance capability.
 */
export type BalanceRegistryEntry = {
  envKey: string;
  displayName: string;
  fetchBalance: BalanceFetcher;
};
