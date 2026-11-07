import type { CatalogKind, CategoryDTO, CustomerDTO, ProductDTO, SupplierDTO } from "@/lib/catalog/types";
import type { IconName } from "@/components/ui/icon";

export type CatalogItem = CategoryDTO | SupplierDTO | CustomerDTO | ProductDTO;

export const catalogMeta: Record<CatalogKind, { title: string; singular: string; path: string; icon: IconName; headline: string; description: string; search: string }> = {
  products: { title: "Produtos", singular: "produto", path: "/produtos", icon: "package", headline: "Cada produto, bem cadastrado", description: "Organize os produtos, seus códigos e as informações que acompanham o estoque.", search: "Pesquisar por nome, SKU ou código de barras" },
  categories: { title: "Categorias", singular: "categoria", path: "/categorias", icon: "layers", headline: "Uma organização que faz sentido", description: "Agrupe produtos em categorias para encontrar o que precisa com mais facilidade.", search: "Pesquisar categorias" },
  suppliers: { title: "Fornecedores", singular: "fornecedor", path: "/fornecedores", icon: "partners", headline: "Seus parceiros, por perto", description: "Mantenha os contatos e as informações dos fornecedores em um só lugar.", search: "Pesquisar por nome, documento ou e-mail" },
  customers: { title: "Clientes", singular: "cliente", path: "/clientes", icon: "partners", headline: "Conheça quem está do outro lado", description: "Consulte e organize os dados dos clientes que fazem parte da sua operação.", search: "Pesquisar por nome, documento ou e-mail" }
};

export function formatCatalogDecimal(value: string, minimumDecimals = 0): string {
  const [integer, fraction = ""] = value.split(".");
  const decimals = fraction.replace(/0+$/, "").padEnd(minimumDecimals, "0");
  return integer.replace(/\B(?=(\d{3})+(?!\d))/g, ".") + (decimals ? `,${decimals}` : "");
}

export function formatCatalogMoney(value: string): string { return `R$ ${formatCatalogDecimal(value, 2)}`; }

export function formatCatalogDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Data não disponível" : new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(date);
}
