BEGIN;

-- A stale form cannot silently overwrite a newer catalog edit.
ALTER TABLE "public"."categories"
    ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0,
    ADD CONSTRAINT "categories_version_check" CHECK ("version" >= 0);
ALTER TABLE "public"."suppliers"
    ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0,
    ADD CONSTRAINT "suppliers_version_check" CHECK ("version" >= 0);
ALTER TABLE "public"."customers"
    ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0,
    ADD CONSTRAINT "customers_version_check" CHECK ("version" >= 0);
ALTER TABLE "public"."products"
    ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0,
    ADD CONSTRAINT "products_version_check" CHECK ("version" >= 0);

-- Inactive categories keep their identity and their reserved name.
CREATE UNIQUE INDEX "categories_name_case_insensitive_key"
    ON "public"."categories" (lower(btrim("name")));

COMMIT;
