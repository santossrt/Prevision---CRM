import type { Metadata } from "next";
import { CatalogPage } from "@/components/catalog/catalog-page";

export const metadata: Metadata = { title: "Produtos" };
export default async function ProductsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const candidate = (await searchParams).barcode;
  const barcode = typeof candidate === "string" ? candidate.trim() : "";
  const initialBarcode = barcode.length > 0 && barcode.length <= 128 && !/[\s\u0000-\u001f\u007f]/u.test(barcode) ? barcode : undefined;
  return <CatalogPage kind="products" initialBarcode={initialBarcode} />;
}
