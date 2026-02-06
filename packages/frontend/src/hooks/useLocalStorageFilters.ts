import { useState, useCallback } from "react";

type FilterValue = string | number | undefined;
type Filters = Record<string, FilterValue>;

/**
 * Hook for persisting filters to localStorage only (no URL sync).
 * Use this for tab components that share a URL route.
 */
export function useLocalStorageFilters<T extends Filters>(
  storageKey: string,
  defaultFilters: T,
): [T, (key: keyof T, value: FilterValue) => void, (newFilters: Partial<T>) => void] {
  // Initialize filters from localStorage or defaults
  const getInitialFilters = (): T => {
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
  };

  const [filters, setFiltersState] = useState<T>(getInitialFilters);

  // Save to localStorage
  const saveToStorage = useCallback(
    (newFilters: T) => {
      try {
        // Only store non-default, non-empty values
        const toStore: Partial<T> = {};
        for (const [key, value] of Object.entries(newFilters)) {
          if (value !== undefined && value !== "") {
            (toStore as Record<string, FilterValue>)[key] = value;
          }
        }
        localStorage.setItem(storageKey, JSON.stringify(toStore));
      } catch {
        // Ignore storage errors
      }
    },
    [storageKey],
  );

  // Update a single filter
  const setFilter = useCallback(
    (key: keyof T, value: FilterValue) => {
      setFiltersState((prev) => {
        const newFilters = {
          ...prev,
          [key]: value === "" ? undefined : value,
          // Reset page to 1 when changing filters (except for page itself)
          ...(key !== "page" ? { page: 1 } : {}),
        } as T;
        saveToStorage(newFilters);
        return newFilters;
      });
    },
    [saveToStorage],
  );

  // Update multiple filters at once
  const setMultipleFilters = useCallback(
    (newFilters: Partial<T>) => {
      setFiltersState((prev) => {
        const updated = { ...prev, ...newFilters } as T;
        saveToStorage(updated);
        return updated;
      });
    },
    [saveToStorage],
  );

  return [filters, setFilter, setMultipleFilters];
}
