/**
 * React hook for consuming Server-Sent Events from the API
 *
 * Provides real-time updates for pipeline activity without polling.
 * Automatically connects/disconnects when component mounts/unmounts.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import type { ServerEvent } from "@watch-tower/shared";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3001";
const API_KEY = import.meta.env.VITE_API_KEY ?? "";

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

export type UseServerEventsOptions = {
  /** Called for each event received */
  onEvent?: (event: ServerEvent) => void;
  /** Called when connection status changes */
  onStatusChange?: (status: ConnectionStatus) => void;
  /**
   * Called when connection is established or re-established.
   * Use this to refresh data that may have been missed during disconnect.
   * This fires on initial connect AND on every reconnect.
   */
  onConnect?: () => void;
  /** Auto-reconnect on disconnect (default: true) */
  autoReconnect?: boolean;
  /** Reconnect delay in ms (default: 3000) */
  reconnectDelay?: number;
};

export type UseServerEventsReturn = {
  /** Current connection status */
  status: ConnectionStatus;
  /** Last event received */
  lastEvent: ServerEvent | null;
  /** Manually reconnect */
  reconnect: () => void;
  /** Manually disconnect */
  disconnect: () => void;
};

/**
 * Hook to subscribe to real-time server events via SSE
 *
 * @example
 * ```tsx
 * const { status, lastEvent } = useServerEvents({
 *   onEvent: (event) => {
 *     if (event.type === 'article:embedded') {
 *       refetchArticles();
 *     }
 *   },
 * });
 * ```
 */
export const useServerEvents = (options: UseServerEventsOptions = {}): UseServerEventsReturn => {
  const {
    onEvent,
    onStatusChange,
    onConnect,
    autoReconnect = true,
    reconnectDelay = 3000,
  } = options;

  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [lastEvent, setLastEvent] = useState<ServerEvent | null>(null);

  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Stable callback refs
  const onEventRef = useRef(onEvent);
  const onStatusChangeRef = useRef(onStatusChange);
  const onConnectRef = useRef(onConnect);
  onEventRef.current = onEvent;
  onStatusChangeRef.current = onStatusChange;
  onConnectRef.current = onConnect;

  const updateStatus = useCallback((newStatus: ConnectionStatus) => {
    setStatus(newStatus);
    onStatusChangeRef.current?.(newStatus);
  }, []);

  const connect = useCallback(() => {
    // Clean up existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    // Clear any pending reconnect
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    updateStatus("connecting");

    // Build URL with API key as query param (SSE doesn't support custom headers)
    const url = new URL(`${API_URL}/api/events`);
    if (API_KEY) {
      url.searchParams.set("api_key", API_KEY);
    }

    const eventSource = new EventSource(url.toString());
    eventSourceRef.current = eventSource;

    eventSource.onopen = () => {
      updateStatus("connected");
      // Trigger data refresh on connect/reconnect to catch missed events
      onConnectRef.current?.();
    };

    eventSource.onerror = () => {
      updateStatus("error");
      eventSource.close();

      if (autoReconnect) {
        reconnectTimeoutRef.current = setTimeout(() => {
          connect();
        }, reconnectDelay);
      }
    };

    // Listen for all event types
    const eventTypes = [
      "connected",
      "article:ingested",
      "article:embedded",
      "article:scored",
      "article:approved",
      "article:rejected",
      "article:posted",
      "source:fetched",
      "stats:updated",
    ];

    eventTypes.forEach((eventType) => {
      eventSource.addEventListener(eventType, (e) => {
        try {
          const event = JSON.parse((e as MessageEvent).data) as ServerEvent;
          setLastEvent(event);
          onEventRef.current?.(event);
        } catch {
          // Ignore parse errors (e.g., for "connected" event)
        }
      });
    });
  }, [autoReconnect, reconnectDelay, updateStatus]);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    updateStatus("disconnected");
  }, [updateStatus]);

  const reconnect = useCallback(() => {
    disconnect();
    connect();
  }, [connect, disconnect]);

  // Connect on mount, disconnect on unmount
  useEffect(() => {
    connect();
    return () => {
      disconnect();
    };
  }, [connect, disconnect]);

  return {
    status,
    lastEvent,
    reconnect,
    disconnect,
  };
};
