export const importColumns = [
  ["nome", "Nome"], ["sku", "SKU"], ["codigo_barras", "Código de barras"], ["categoria", "Categoria"],
  ["fornecedor", "Fornecedor"], ["documento_fornecedor", "Documento do fornecedor"], ["unidade", "Unidade"],
  ["estoque_minimo", "Estoque mínimo"], ["custo_aquisicao", "Custo de aquisição"], ["preco_venda", "Preço de venda"],
  ["estoque_seguranca", "Estoque de segurança"], ["prazo_reposicao_dias", "Prazo de reposição (dias)"], ["descricao", "Descrição"], ["ativo", "Ativo"]
] as const;
export type ImportColumn = typeof importColumns[number][0];
export const importColumnLabels = Object.fromEntries(importColumns) as Record<ImportColumn, string>;
export function headerKey(value: string): string {
  const normalized = value.normalize("NFD").replace(/\p{M}/gu, "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return ({ codigo_de_barras: "codigo_barras", documento_do_fornecedor: "documento_fornecedor", custo_de_aquisicao: "custo_aquisicao", preco_de_venda: "preco_venda", estoque_de_seguranca: "estoque_seguranca", prazo_de_reposicao_dias: "prazo_reposicao_dias" } as Record<string, string>)[normalized] ?? normalized;
}
