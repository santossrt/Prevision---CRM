"use client";
import { useEffect, useId, useState, type SubmitEvent } from "react";
import { catalogError, CatalogRequestError, isCancelled } from "@/components/catalog/catalog-api";
import { Icon } from "@/components/ui/icon";
import type { ThemeMode, UserPreferenceDTO } from "@/lib/preferences/types";
import { applyTheme, readPreferences, savePreferences } from "./preferences-api";

const choices: { value: ThemeMode; title: string; description: string }[] = [
  { value: "system", title: "Conforme o sistema", description: "Acompanha automaticamente a aparência escolhida no seu dispositivo." },
  { value: "light", title: "Claro", description: "Superfícies claras e tons de verde para o seu dia a dia." },
  { value: "dark", title: "Escuro", description: "Superfícies escuras com textos e indicadores de alto contraste." }
];

export function AppearanceSettings() {
  const id = useId();
  const [saved, setSaved] = useState<UserPreferenceDTO | null>(null);
  const [selected, setSelected] = useState<ThemeMode>("system");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(""); setConflict(false); setNotice("");
    void readPreferences(controller.signal).then((preference) => {
      if (controller.signal.aborted) return;
      setSaved(preference); setSelected(preference.theme); applyTheme(preference.theme);
    }).catch((failure) => { if (!isCancelled(failure)) setError(catalogError(failure)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision]);

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!saved || pending || loading || conflict) return;
    setPending(true); setError(""); setNotice("");
    try {
      const preference = await savePreferences(selected, saved.version);
      setSaved(preference); setSelected(preference.theme); applyTheme(preference.theme);
      setNotice("Aparência salva para sua conta. A preferência também será usada nos seus próximos acessos.");
    } catch (failure) {
      setError(catalogError(failure));
      if (failure instanceof CatalogRequestError && failure.status === 409) setConflict(true);
    } finally { setPending(false); }
  }

  return <section className="management-panel appearance-panel" aria-labelledby={`${id}-title`}>
    <div className="appearance-heading"><span className="module-icon"><Icon name="settings" /></span><div><h2 id={`${id}-title`}>Aparência</h2><p>Escolha como você prefere ver o Prevision.</p></div></div>
    {loading && <p className="appearance-state" role="status">Consultando sua preferência…</p>}
    {!loading && <form onSubmit={(event) => void submit(event)}>
      <fieldset className="theme-options" disabled={pending || !saved || conflict} aria-describedby={`${id}-help`}>
        <legend>Tema da aplicação</legend>
        {choices.map((choice) => <label key={choice.value} className={`theme-option${selected === choice.value ? " theme-option-selected" : ""}`}>
          <input type="radio" name={`${id}-theme`} value={choice.value} checked={selected === choice.value} onChange={() => { setSelected(choice.value); setNotice(""); }} />
          <span className={`theme-swatch theme-swatch-${choice.value}`} aria-hidden="true"><span /><span /><span /></span>
          <strong>{choice.title}</strong><span className="theme-option-description">{choice.description}</span>
        </label>)}
      </fieldset>
      <p className="appearance-note" id={`${id}-help`}>A escolha é individual e não altera a aparência dos outros usuários. No modo conforme o sistema, mudanças no tema do dispositivo são aplicadas automaticamente.</p>
      {error && <div className="form-message form-error" role="alert"><p>{error}</p><button className="text-link" type="button" disabled={pending} onClick={() => setRevision((value) => value + 1)}>Recarregar preferências</button></div>}
      {notice && <p className="form-message form-success" role="status">{notice}</p>}
      <div className="appearance-actions"><span>{saved && !conflict && selected !== saved.theme ? "Você tem uma alteração para salvar." : "Sua preferência fica vinculada à sua conta."}</span><button type="submit" className="button-primary" disabled={pending || !saved || conflict || selected === saved.theme}>{pending ? "Salvando…" : "Salvar aparência"}<Icon name="check" /></button></div>
    </form>}
  </section>;
}
