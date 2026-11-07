import type { Metadata } from "next";
import { CatalogPage } from "@/components/catalog/catalog-page";

export const metadata: Metadata = { title: "Fornecedores" };
export default function SuppliersPage() { return <CatalogPage kind="suppliers" />; }
