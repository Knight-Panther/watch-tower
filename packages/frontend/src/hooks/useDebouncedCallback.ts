import { useRef, useCallback } from "react";

/**
 * Returns a debounced version of the callback.
 * Batches rapid invocations into a single call after `delayMs` of inactivity.
 */
export const useDebouncedCallback = (fn: () => void, delayMs: number) => {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  return useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(fn, delayMs);
  }, [fn, delayMs]);
};
