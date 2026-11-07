"use client";
import { useCallback, useEffect, useState } from "react";
import { NotificationRequestError, notificationError } from "./notifications-api.ts";

const events = ["focus", "prevision:notifications-changed", "prevision:stock-changed", "prevision:inventory-changed", "prevision:catalog-changed"];
type Resource<T> = { key: string; data: T | null; loading: boolean; error: string };

/** One active request per owner/query; old responses cannot replace new state. */
export function useNotifications<T>(key: string, load: (signal: AbortSignal) => Promise<T>) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<Resource<T>>({ key, data: null, loading: true, error: "" });
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    const interval = window.setInterval(visible, 30000);
    events.forEach((name) => window.addEventListener(name, visible));
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.clearInterval(interval);
      events.forEach((name) => window.removeEventListener(name, visible));
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);
  useEffect(() => {
    if (document.visibilityState === "hidden") return;
    const controller = new AbortController();
    setState((previous) => ({ key, data: previous.key === key ? previous.data : null, loading: true, error: "" }));
    void load(controller.signal).then((data) => {
      if (!controller.signal.aborted) setState({ key, data, loading: false, error: "" });
    }).catch((error) => {
      if (controller.signal.aborted) return;
      const accessLost = error instanceof NotificationRequestError && [401, 403].includes(error.status);
      setState((previous) => ({ key, data: !accessLost && previous.key === key ? previous.data : null, loading: false, error: notificationError(error) }));
    });
    return () => controller.abort();
  }, [key, load, revision]);
  return { ...(state.key === key ? state : { key, data: null, loading: true, error: "" }), refresh };
}
