import type { Metadata } from "next";
import { CatalogPage } from "@/components/catalog/catalog-page";

export const metadata: Metadata = { title: "Clientes" };
export default function CustomersPage() { return <CatalogPage kind="customers" />; }
