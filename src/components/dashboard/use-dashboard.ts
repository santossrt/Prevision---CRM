"use client";
import { useCallback, useEffect, useState } from "react";
import type { DashboardDTO } from "../../lib/dashboard/types.ts";
import { DashboardRequestError, dashboardError, getDashboard } from "./dashboard-api.ts";

type Resource = { key: string; data: DashboardDTO | null; loading: boolean; error: string };
export function useDashboard(ownerId: string, query: string, ready: boolean) {
  const key = `${ownerId}:${query}`;
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<Resource>({ key, data: null, loading: true, error: "" });
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    const events = ["focus", "prevision:stock-changed", "prevision:inventory-changed", "prevision:catalog-changed"];
    const interval = window.setInterval(visible, 60000);
    events.forEach((name) => window.addEventListener(name, visible));
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.clearInterval(interval);
      events.forEach((name) => window.removeEventListener(name, visible));
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);
  useEffect(() => {
    if (!ready || document.visibilityState === "hidden") return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(new DOMException("Tempo de consulta excedido", "TimeoutError")), 30000);
    let disposed = false;
    setState((previous) => ({ key, data: previous.key === key ? previous.data : null, loading: true, error: "" }));
    void getDashboard(query, controller.signal).then((data) => {
      if (!disposed) setState({ key, data, loading: false, error: "" });
    }).catch((error) => {
      if (disposed) return;
      const denied = error instanceof DashboardRequestError && [401, 403].includes(error.status);
      setState((previous) => ({ key, data: !denied && previous.key === key ? previous.data : null, loading: false, error: controller.signal.aborted ? "A consulta demorou mais que o esperado. Tente atualizar novamente." : dashboardError(error) }));
    }).finally(() => window.clearTimeout(timeout));
    return () => { disposed = true; window.clearTimeout(timeout); controller.abort(); };
  }, [key, query, ready, revision]);
  return { ...(state.key === key ? state : { key, data: null, loading: true, error: "" }), refresh };
}
