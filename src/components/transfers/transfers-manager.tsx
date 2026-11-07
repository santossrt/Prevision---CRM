"use client";

import { useId, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { canImportProducts } from "@/lib/transfers/access";
import { allowedReports } from "./transfers-meta";
import { ImportPanel } from "./import-panel";
import { ExportPanel } from "./export-panel";

export function TransfersManager({ ownerId, permissions }: { ownerId: string; permissions: string[] }) {
  const id = useId();
  const canImport = canImportProducts(permissions);
  const kinds = allowedReports(permissions);
  const [tab, setTab] = useState<"import" | "export">(canImport ? "import" : "export");
  function switchTab(value: "import" | "export") {
    setTab(value);
    document.getElementById(`${id}-${value}-tab`)?.focus();
  }
  return <>
    <div className="catalog-tabs transfer-tabs" role="tablist" aria-label="Importação e exportação">
      {canImport && <button id={`${id}-import-tab`} type="button" role="tab" aria-controls={`${id}-import-panel`} aria-selected={tab === "import"} tabIndex={tab === "import" ? 0 : -1} onClick={() => switchTab("import")} onKeyDown={(event) => { if (kinds.length && (event.key === "ArrowRight" || event.key === "ArrowLeft")) { event.preventDefault(); switchTab("export"); } }}><Icon name="package" />Importar produtos</button>}
      {kinds.length > 0 && <button id={`${id}-export-tab`} type="button" role="tab" aria-controls={`${id}-export-panel`} aria-selected={tab === "export"} tabIndex={tab === "export" ? 0 : -1} onClick={() => switchTab("export")} onKeyDown={(event) => { if (canImport && (event.key === "ArrowRight" || event.key === "ArrowLeft")) { event.preventDefault(); switchTab("import"); } }}><Icon name="chart" />Exportar relatórios</button>}
    </div>
    {tab === "import" && canImport ? <div id={`${id}-import-panel`} role="tabpanel" aria-labelledby={`${id}-import-tab`}><ImportPanel key={ownerId} ownerId={ownerId} /></div> : kinds.length > 0 && <div id={`${id}-export-panel`} role="tabpanel" aria-labelledby={`${id}-export-tab`}><ExportPanel kinds={kinds} /></div>}
    <p className="management-footnote"><Icon name="shield" />As permissões são verificadas na prévia, na confirmação e no download. Os arquivos disponíveis correspondem ao seu acesso aos módulos.</p>
  </>;
}
