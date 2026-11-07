"use client";

import { useCallback, useEffect, useState } from "react";
import { CatalogRequestError, catalogError, catalogRequest, isCancelled } from "@/components/catalog/catalog-api";

type Resource<T> = { path: string; data: T | null; loading: boolean; error: string };

/** Refresh only while visible; the server remains the source of alert state. */
export function useStockAlerts<T>(path: string) {
  const [revision, setRevision] = useState(0);
  const [resource, setResource] = useState<Resource<T>>({ path, data: null, loading: true, error: "" });
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    const whenVisible = () => { if (document.visibilityState === "visible") refresh(); };
    const interval = window.setInterval(whenVisible, 30000);
    window.addEventListener("focus", whenVisible);
    window.addEventListener("prevision:stock-changed", whenVisible);
    document.addEventListener("visibilitychange", whenVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", whenVisible);
      window.removeEventListener("prevision:stock-changed", whenVisible);
      document.removeEventListener("visibilitychange", whenVisible);
    };
  }, [refresh]);

  useEffect(() => {
    if (document.visibilityState === "hidden") return;
    const controller = new AbortController();
    setResource((previous) => ({ path, data: previous.path === path ? previous.data : null, loading: true, error: "" }));
    void catalogRequest<T>(path, { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setResource({ path, data, loading: false, error: "" }); })
      .catch((error) => {
        if (!controller.signal.aborted && !isCancelled(error)) {
          const lostAccess = error instanceof CatalogRequestError && (error.status === 401 || error.status === 403);
          setResource((previous) => ({ path, data: !lostAccess && previous.path === path ? previous.data : null, loading: false, error: catalogError(error) }));
        }
      });
    return () => controller.abort();
  }, [path, revision]);

  return { ...(resource.path === path ? resource : { path, data: null, loading: true, error: "" }), refresh };
}
