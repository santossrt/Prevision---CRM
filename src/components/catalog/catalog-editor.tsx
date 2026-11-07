"use client";

import { useId, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import type { CatalogKind, CatalogOptions, ProductDTO } from "@/lib/catalog/types";
import { CatalogModal } from "./catalog-modal";
import { catalogError, catalogRequest, CatalogRequestError } from "./catalog-api";
import { catalogMeta, type CatalogItem } from "./catalog-meta";

type Fields = Record<string, string>;
const decimalFields = ["minimumStock", "safetyStock", "acquisitionCost", "salePrice"] as const;

function initialFields(item?: CatalogItem): Fields {
  const product = item && "sku" in item ? item : undefined;
  const party = item && "taxId" in item ? item : undefined;
  return {
    name: item?.name ?? "", description: item && "description" in item ? item.description ?? "" : "",
    taxId: party?.taxId ?? "", email: party?.email ?? "", phone: party?.phone ?? "", address: party?.address ?? "",
    sku: product?.sku ?? "", barcode: product?.barcode ?? "", categoryId: product?.categoryId ?? "",
    defaultSupplierId: product?.defaultSupplierId ?? "", unitOfMeasure: product?.unitOfMeasure ?? "UN",
    minimumStock: (product?.minimumStock ?? "0").replace(".", ","), safetyStock: (product?.safetyStock ?? "0").replace(".", ","),
    acquisitionCost: (product?.acquisitionCost ?? "0").replace(".", ","), salePrice: (product?.salePrice ?? "0").replace(".", ","),
    replenishmentLeadTimeDays: item && "replenishmentLeadTimeDays" in item ? String(item.replenishmentLeadTimeDays ?? "") : ""
  };
}

function Field({ id, label, hint, children, wide = false }: { id: string; label: string; hint?: string; children: ReactNode; wide?: boolean }) {
  return <div className={`form-field${wide ? " catalog-field-wide" : ""}`}><label htmlFor={id}>{label}</label>{children}{hint && <p id={`${id}-hint`} className="field-hint">{hint}</p>}</div>;
}

export function CatalogEditor({ kind, item, options, initialBarcode, onClose, onSaved, onReload }: {
  kind: CatalogKind; item?: CatalogItem; options: CatalogOptions | null; initialBarcode?: string;
  onClose: () => void; onSaved: (message: string) => void; onReload: () => void;
}) {
  const meta = catalogMeta[kind];
  const prefix = useId();
  const [fields, setFields] = useState<Fields>(() => ({ ...initialFields(item), ...(!item && kind === "products" && initialBarcode ? { barcode: initialBarcode } : {}) }));
  const [isActive, setIsActive] = useState(item?.isActive ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const product = item && "sku" in item ? item as ProductDTO : undefined;
  const update = (name: string, value: string) => setFields((current) => ({ ...current, [name]: value }));
  const fieldId = (name: string) => `${prefix}-${name}`;
  const input = (name: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => <input id={fieldId(name)} value={fields[name]} onChange={(event) => update(name, event.target.value)} disabled={busy} {...props} />;
  const categoryOptions = (options?.categories ?? []).filter((entry) => entry.isActive);
  if (product && !categoryOptions.some((entry) => entry.id === product.category.id)) categoryOptions.push(product.category);
  const supplierOptions = (options?.suppliers ?? []).filter((entry) => entry.isActive);
  if (product?.defaultSupplier && !supplierOptions.some((entry) => entry.id === product.defaultSupplier!.id)) supplierOptions.push(product.defaultSupplier);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setConflict(false);
    let body: Record<string, unknown> = { name: fields.name.trim(), isActive };
    if (kind === "products") {
      body = { ...body, sku: fields.sku.trim(), barcode: fields.barcode.trim() || null, description: fields.description.trim() || null,
        categoryId: fields.categoryId, defaultSupplierId: fields.defaultSupplierId || null, unitOfMeasure: fields.unitOfMeasure.trim(),
        replenishmentLeadTimeDays: fields.replenishmentLeadTimeDays === "" ? null : Number(fields.replenishmentLeadTimeDays) };
      for (const name of decimalFields) {
        const value = fields[name].trim().replace(",", ".");
        if (!/^\d+(?:\.\d{1,4})?$/.test(value) || value.split(".")[0].replace(/^0+/, "").length > 14) {
          setError("Confira as quantidades e os valores: use números não negativos, até quatro casas decimais e nenhum separador de milhar.");
          return;
        }
        body[name] = value;
      }
    } else if (kind === "categories") body.description = fields.description.trim() || null;
    else {
      body = { ...body, taxId: fields.taxId.trim() || null, email: fields.email.trim() || null, phone: fields.phone.trim() || null, address: fields.address.trim() || null };
      if (kind === "suppliers") body.replenishmentLeadTimeDays = fields.replenishmentLeadTimeDays === "" ? null : Number(fields.replenishmentLeadTimeDays);
    }
    if (item) body.expectedVersion = item.version;
    setBusy(true);
    try {
      const result = await catalogRequest<{ item: CatalogItem; message: string }>(`/api/catalog/${kind}${item ? `/${encodeURIComponent(item.id)}` : ""}`, { method: item ? "PATCH" : "POST", body });
      onSaved(result.message || "Cadastro salvo com sucesso.");
    } catch (failure) {
      setError(catalogError(failure));
      setConflict(failure instanceof CatalogRequestError && failure.status === 409 && !!item);
    } finally { setBusy(false); }
  }

  return <CatalogModal title={item ? `Editar ${meta.singular}` : `Adicionar ${meta.singular}`} caption={meta.title.toLocaleUpperCase("pt-BR")} onClose={onClose} busy={busy} wide={kind === "products"}>
    <p className="dialog-description">{item ? kind === "products" ? "Atualize as informações do cadastro. Alterações de valores ficam registradas no histórico." : "Atualize as informações deste cadastro." : "Preencha as informações abaixo. Os campos opcionais podem ser completados depois."}</p>
    <form className="catalog-form" onSubmit={submit}>
      <div className="catalog-form-grid">
        <Field id={fieldId("name")} label="Nome" wide>{input("name", { required: true, maxLength: kind === "categories" ? 100 : 160, autoFocus: true, autoComplete: "off" })}</Field>
        {kind === "products" ? <>
          <Field id={fieldId("sku")} label="Código SKU" hint="Código único do produto, sem espaços.">{input("sku", { required: true, maxLength: 64, autoComplete: "off", className: "catalog-code-input" })}</Field>
          <Field id={fieldId("barcode")} label="Código de barras (opcional)" hint="Os zeros à esquerda são preservados.">{input("barcode", { maxLength: 128, autoComplete: "off" })}</Field>
          <Field id={fieldId("categoryId")} label="Categoria"><select id={fieldId("categoryId")} value={fields.categoryId} onChange={(event) => update("categoryId", event.target.value)} required disabled={busy}><option value="">Selecione uma categoria</option>{categoryOptions.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}{entry.isActive ? "" : " (inativa)"}</option>)}</select>{!categoryOptions.length && <Link className="text-link" href="/categorias">Cadastre uma categoria para continuar</Link>}</Field>
          <Field id={fieldId("defaultSupplierId")} label="Fornecedor padrão (opcional)"><select id={fieldId("defaultSupplierId")} value={fields.defaultSupplierId} onChange={(event) => update("defaultSupplierId", event.target.value)} disabled={busy}><option value="">Sem fornecedor padrão</option>{supplierOptions.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}{entry.isActive ? "" : " (inativo)"}</option>)}</select></Field>
          <Field id={fieldId("unitOfMeasure")} label="Unidade de medida" hint="Por exemplo: UN, KG, L ou M.">{input("unitOfMeasure", { required: true, maxLength: 20, className: "catalog-code-input" })}</Field>
          <Field id={fieldId("replenishmentLeadTimeDays")} label="Prazo de reposição em dias (opcional)">{input("replenishmentLeadTimeDays", { type: "number", min: 0, max: 3650, step: 1, inputMode: "numeric" })}</Field>
          <Field id={fieldId("minimumStock")} label="Estoque mínimo">{input("minimumStock", { required: true, inputMode: "decimal", maxLength: 24 })}</Field>
          <Field id={fieldId("safetyStock")} label="Estoque de segurança">{input("safetyStock", { required: true, inputMode: "decimal", maxLength: 24 })}</Field>
          <Field id={fieldId("acquisitionCost")} label="Custo de aquisição (R$)">{input("acquisitionCost", { required: true, inputMode: "decimal", maxLength: 24 })}</Field>
          <Field id={fieldId("salePrice")} label="Preço de venda (R$)">{input("salePrice", { required: true, inputMode: "decimal", maxLength: 24 })}</Field>
          <p className="field-hint catalog-field-wide">Quantidades e valores aceitam vírgula ou ponto e até quatro casas decimais, sem separador de milhar.</p>
          <div className="readonly-field catalog-field-wide"><span>Quantidade em estoque</span><strong>{product ? `${product.quantity.replace(".", ",")} ${product.unitOfMeasure}` : "0"}</strong></div>
          {!item && <p className="field-hint catalog-field-wide">O cadastro começa com saldo zero. Entradas e saídas serão registradas no módulo de estoque.</p>}
        </> : kind !== "categories" ? <>
          <Field id={fieldId("taxId")} label="Documento (opcional)" hint="CPF, CNPJ ou outro documento, com letras e números.">{input("taxId", { maxLength: 64, autoComplete: "off" })}</Field>
          <Field id={fieldId("email")} label="E-mail (opcional)">{input("email", { type: "email", maxLength: 254, autoComplete: "email" })}</Field>
          <Field id={fieldId("phone")} label="Telefone (opcional)">{input("phone", { type: "tel", maxLength: 32, autoComplete: "tel" })}</Field>
          {kind === "suppliers" && <Field id={fieldId("replenishmentLeadTimeDays")} label="Prazo de reposição em dias (opcional)">{input("replenishmentLeadTimeDays", { type: "number", min: 0, max: 3650, step: 1, inputMode: "numeric" })}</Field>}
          <Field id={fieldId("address")} label="Endereço (opcional)" wide><textarea id={fieldId("address")} value={fields.address} onChange={(event) => update("address", event.target.value)} maxLength={4000} rows={3} disabled={busy} autoComplete="street-address" /></Field>
        </> : null}
        {(kind === "products" || kind === "categories") && <Field id={fieldId("description")} label="Descrição (opcional)" wide><textarea id={fieldId("description")} value={fields.description} onChange={(event) => update("description", event.target.value)} maxLength={4000} rows={3} disabled={busy} /></Field>}
      </div>
      <label className="checkbox-field"><input type="checkbox" checked={isActive} onChange={(event) => setIsActive(event.target.checked)} disabled={busy} /><span><strong>Cadastro ativo</strong><span>Cadastros inativos permanecem disponíveis para consulta e preservam suas referências.</span></span></label>
      {error && <div className="form-message form-error" role="alert"><p>{error}</p>{conflict && <><p>Se outra pessoa editou este cadastro, carregue a versão atual para revisar os dados. Alterações deste formulário ainda não foram salvas.</p><button className="text-link" type="button" disabled={busy} onClick={onReload}>Carregar versão atual</button></>}</div>}
      <div className="dialog-actions"><button className="button-secondary" type="button" onClick={onClose} disabled={busy}>Cancelar</button><button className="button-primary" type="submit" disabled={busy || (kind === "products" && !categoryOptions.length)}>{busy ? "Salvando…" : item ? "Salvar alterações" : "Salvar cadastro"}</button></div>
    </form>
  </CatalogModal>;
}
