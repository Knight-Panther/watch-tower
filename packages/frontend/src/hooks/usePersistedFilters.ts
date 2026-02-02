import { useState, useEffect, useCallback } from "react";
import { useSearchParams } from "react-router-dom";

type FilterValue = string | number | undefined;
type Filters = Record<string, FilterValue>;

/**
 * Hook for persisting filters across sessions using localStorage + URL sync.
 *
 * Priority order on load:
 * 1. URL search params (allows sharing/bookmarking)
 * 2. localStorage (persists across sessions)
 * 3. defaultFilters (fallback)
 *
 * On change:
 * - Updates URL search params (for sharing)
 * - Saves to localStorage (for persistence)
 */
export function usePersistedFilters<T extends Filters>(
  storageKey: string,
  defaultFilters: T,
): [T, (key: keyof T, value: FilterValue) => void, (newFilters: Partial<T>) => void] {
  const [searchParams, setSearchParams] = useSearchParams();

  // Initialize filters from URL > localStorage > defaults
  const getInitialFilters = useCallback((): T => {
    // First, check URL params
    const urlFilters: Partial<T> = {};
    let hasUrlParams = false;

    for (const key of Object.keys(defaultFilters)) {
      const urlValue = searchParams.get(key);
      if (urlValue !== null) {
        hasUrlParams = true;
        // Try to parse as number if the default is a number
        if (typeof defaultFilters[key] === "number") {
          const num = Number(urlValue);
          if (!Number.isNaN(num)) {
            (urlFilters as Record<string, FilterValue>)[key] = num;
          }
        } else {
          (urlFilters as Record<string, FilterValue>)[key] = urlValue;
        }
      }
    }

    // If URL has params, use them (merged with defaults)
    if (hasUrlParams) {
      return { ...defaultFilters, ...urlFilters };
    }

    // Otherwise, try localStorage
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const parsed = JSON.parse(stored) as Partial<T>;
        return { ...defaultFilters, ...parsed };
      }
    } catch {
      // Ignore parse errors
    }

    return defaultFilters;
  }, [storageKey, defaultFilters, searchParams]);

  const [filters, setFilters] = useState<T>(getInitialFilters);

  // Sync to URL and localStorage when filters change
  const syncFilters = useCallback(
    (newFilters: T) => {
      // Update URL params
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(newFilters)) {
        if (value !== undefined && value !== "" && value !== defaultFilters[key]) {
          params.set(key, String(value));
        }
      }
      setSearchParams(params, { replace: true });

      // Save to localStorage (only non-default values to keep it clean)
      const toStore: Partial<T> = {};
      for (const [key, value] of Object.entries(newFilters)) {
        if (value !== undefined && value !== "") {
          (toStore as Record<string, FilterValue>)[key] = value;
        }
      }
      try {
        localStorage.setItem(storageKey, JSON.stringify(toStore));
      } catch {
        // Ignore storage errors
      }
    },
    [storageKey, defaultFilters, setSearchParams],
  );

  // Update a single filter
  const setFilter = useCallback(
    (key: keyof T, value: FilterValue) => {
      setFilters((prev) => {
        const newFilters = {
          ...prev,
          [key]: value === "" ? undefined : value,
          // Reset page to 1 when changing filters (except for page itself)
          ...(key !== "page" ? { page: 1 } : {}),
        } as T;
        syncFilters(newFilters);
        return newFilters;
      });
    },
    [syncFilters],
  );

  // Update multiple filters at once
  const setMultipleFilters = useCallback(
    (newFilters: Partial<T>) => {
      setFilters((prev) => {
        const updated = { ...prev, ...newFilters } as T;
        syncFilters(updated);
        return updated;
      });
    },
    [syncFilters],
  );

  // On mount, sync initial state to URL if loaded from localStorage
  useEffect(() => {
    const hasUrlParams = Array.from(searchParams.keys()).some((key) =>
      Object.keys(defaultFilters).includes(key),
    );
    if (!hasUrlParams) {
      // If no URL params, sync current filters to URL
      syncFilters(filters);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return [filters, setFilter, setMultipleFilters];
}
