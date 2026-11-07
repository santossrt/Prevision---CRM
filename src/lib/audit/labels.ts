export const auditModuleLabels: Record<string, string> = {
  AUTH: "Autenticação", USERS: "Usuários", PERMISSIONS: "Permissões", CATEGORIES: "Categorias",
  SUPPLIERS: "Fornecedores", CUSTOMERS: "Clientes", PRODUCTS: "Produtos", STOCK: "Estoque",
  SYSTEM: "Sistema", INVENTORY: "Inventários", TRANSFERS: "Importação e exportação"
};
export const auditActionLabels: Record<string, string> = {
  CREATE: "Criação", UPDATE: "Alteração", ACTIVATE: "Ativação", DEACTIVATE: "Inativação", DELETE: "Exclusão",
  LOGIN_SUCCESS: "Entrada autorizada", LOGIN_FAILURE: "Tentativa de acesso recusada", LOGOUT: "Saída da conta",
  PASSWORD_SETUP: "Definição de senha", PASSWORD_RESET: "Redefinição de senha", PERMISSIONS_CHANGED: "Permissões alteradas",
  STOCK_ENTRY: "Entrada de estoque", STOCK_EXIT: "Saída de estoque", STOCK_ADJUSTMENT: "Ajuste de estoque", STOCK_COMPENSATION: "Compensação de estoque",
  IMPORT: "Importação de produtos", EXPORT: "Exportação de relatório"
};
export const auditFieldLabels: Record<string, string> = {
  id: "Identificador", name: "Nome", email: "E-mail", role: "Perfil", permissions: "Permissões", isActive: "Ativo",
  googleAccessAllowed: "Google autorizado", googleLinked: "Google vinculado", provider: "Provedor",
  passwordResetRequested: "Redefinição solicitada", administrativeReset: "Redefinição administrativa",
  passwordResetDeliveryFailed: "Falha na entrega", activationEmailRequested: "Convite solicitado",
  description: "Descrição", sku: "SKU", barcode: "Código de barras", categoryId: "Categoria (ID)", category: "Categoria",
  defaultSupplierId: "Fornecedor padrão (ID)", defaultSupplier: "Fornecedor padrão", unitOfMeasure: "Unidade",
  quantity: "Quantidade", minimumStock: "Estoque mínimo", safetyStock: "Estoque de segurança",
  acquisitionCost: "Custo de aquisição", salePrice: "Preço de venda", replenishmentLeadTimeDays: "Prazo de reposição (dias)",
  taxId: "Documento", phone: "Telefone", address: "Endereço", version: "Versão", createdAt: "Criado em", updatedAt: "Alterado em",
  productId: "Produto (ID)", type: "Tipo", quantityDelta: "Variação", quantityBefore: "Saldo anterior", quantityAfter: "Saldo resultante",
  historicalUnitCost: "Custo unitário histórico", historicalTotalCost: "Custo total histórico",
  historicalUnitPrice: "Preço unitário histórico", historicalTotalPrice: "Venda total histórica",
  supplierId: "Fornecedor (ID)", customerId: "Cliente (ID)", compensatesMovementId: "Movimentação compensada (ID)",
  justification: "Justificativa", occurredAt: "Data da operação", notes: "Observações", title: "Título",
  inventoryId: "Inventário (ID)", status: "Situação", scope: "Seleção", items: "Itens", itemCount: "Total de itens",
  countedItems: "Itens contados", divergentItems: "Itens divergentes", changedItems: "Referências alteradas",
  productIds: "Produtos (IDs)", categoryIds: "Categorias (IDs)", baselineQuantity: "Saldo de referência",
  baselineVersion: "Versão da referência", countedQuantity: "Quantidade física", difference: "Diferença",
  countedById: "Responsável pela contagem (ID)", countedAt: "Data da contagem", movementId: "Movimentação (ID)", movementIds: "Movimentações (IDs)",
  operationId: "Operação (ID)", openedAt: "Aberto em", completedAt: "Concluído em", canceledAt: "Cancelado em",
  createdById: "Responsável pela abertura (ID)", completedById: "Responsável pela conclusão (ID)", canceledById: "Responsável pelo cancelamento (ID)",
  stockStatus: "Situação do estoque", previousValue: "Valor anterior", newValue: "Novo valor", effectiveAt: "Vigência", code: "Código",
  fileName: "Arquivo", format: "Formato", rowCount: "Total de linhas", validCount: "Linhas válidas", errorCount: "Linhas com erro", createdCount: "Produtos criados",
  importId: "Importação (ID)", exportId: "Exportação (ID)", reportId: "Relatório (ID)", reportKind: "Relatório", kind: "Tipo de relatório", filters: "Filtros",
  expiresAt: "Validade da prévia", search: "Pesquisa", stock: "Situação do estoque", from: "De", to: "Até", actorId: "Responsável (ID)", module: "Módulo", action: "Ação", entityType: "Entidade", entityId: "Registro (ID)"
};
export const moduleLabel = (value: string) => auditModuleLabels[value] ?? value;
export const actionLabel = (value: string) => auditActionLabels[value] ?? value;
