import type { Metadata } from "next";
import { CatalogPage } from "@/components/catalog/catalog-page";

export const metadata: Metadata = { title: "Categorias" };
export default function CategoriesPage() { return <CatalogPage kind="categories" />; }
