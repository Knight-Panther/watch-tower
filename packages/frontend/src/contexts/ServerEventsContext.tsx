import { createContext, useContext, useRef, useCallback, type ReactNode } from "react";
import { useServerEvents, type ConnectionStatus } from "../hooks/useServerEvents";
import type { ServerEvent } from "@watch-tower/shared";

type Subscriber = {
  eventTypes: ServerEvent["type"][];
  callback: (event: ServerEvent) => void;
};

type ServerEventsContextValue = {
  status: ConnectionStatus;
  subscribe: (
    eventTypes: ServerEvent["type"][],
    callback: (event: ServerEvent) => void,
  ) => () => void;
};

const ServerEventsContext = createContext<ServerEventsContextValue | null>(null);

export function ServerEventsProvider({ children }: { children: ReactNode }) {
  const subscribersRef = useRef<Set<Subscriber>>(new Set());

  const subscribe = useCallback(
    (eventTypes: ServerEvent["type"][], callback: (event: ServerEvent) => void) => {
      const subscriber: Subscriber = { eventTypes, callback };
      subscribersRef.current.add(subscriber);
      return () => {
        subscribersRef.current.delete(subscriber);
      };
    },
    [],
  );

  const { status } = useServerEvents({
    onEvent: (event) => {
      subscribersRef.current.forEach((sub) => {
        if (sub.eventTypes.includes(event.type)) {
          sub.callback(event);
        }
      });
    },
    onConnect: () => {
      // On reconnect, notify ALL subscribers to refresh (catch missed events)
      subscribersRef.current.forEach((sub) => {
        if (sub.eventTypes.length > 0) {
          sub.callback({ type: sub.eventTypes[0], data: {} } as ServerEvent);
        }
      });
    },
  });

  return (
    <ServerEventsContext.Provider value={{ status, subscribe }}>
      {children}
    </ServerEventsContext.Provider>
  );
}

export function useServerEventsContext(): ServerEventsContextValue {
  const ctx = useContext(ServerEventsContext);
  if (!ctx) {
    throw new Error("useServerEventsContext must be used within ServerEventsProvider");
  }
  return ctx;
}
