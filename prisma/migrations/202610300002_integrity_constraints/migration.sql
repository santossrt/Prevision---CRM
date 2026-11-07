-- Local, row-level invariants that Prisma's schema language cannot express.
-- Balance/ledger reconciliation, transaction concurrency, compensation against
-- another row and financial rounding rules belong to the stage 4 services.
BEGIN;

ALTER TABLE "public"."environment_sentinel"
    ADD CONSTRAINT "environment_sentinel_singleton_check"
        CHECK ("id" = 'primary'),
    ADD CONSTRAINT "environment_sentinel_environment_check"
        CHECK ("environment" IN ('development', 'test', 'demo')),
    ADD CONSTRAINT "environment_sentinel_database_id_check"
        CHECK (length(btrim("database_id")) > 0);

ALTER TABLE "public"."users"
    ADD CONSTRAINT "users_email_normalized_check"
        CHECK (length("email") > 0 AND "email" = lower(btrim("email"))),
    ADD CONSTRAINT "users_name_not_blank_check"
        CHECK ("name" IS NULL OR length(btrim("name")) > 0),
    ADD CONSTRAINT "users_session_version_check"
        CHECK ("session_version" >= 0);

ALTER TABLE "public"."roles"
    ADD CONSTRAINT "roles_name_not_blank_check"
        CHECK (length(btrim("name")) > 0);

ALTER TABLE "public"."permissions"
    ADD CONSTRAINT "permissions_code_not_blank_check"
        CHECK (length(btrim("code")) > 0 AND "code" = btrim("code"));

ALTER TABLE "public"."auth_accounts"
    ADD CONSTRAINT "auth_accounts_identity_not_blank_check"
        CHECK (
            length(btrim("type")) > 0
            AND length(btrim("provider")) > 0
            AND length(btrim("provider_account_id")) > 0
        );

ALTER TABLE "public"."login_sessions"
    ADD CONSTRAINT "login_sessions_version_check"
        CHECK ("session_version" >= 0),
    ADD CONSTRAINT "login_sessions_timestamps_check"
        CHECK (
            "expires_at" > "created_at"
            AND ("revoked_at" IS NULL OR "revoked_at" >= "created_at")
            AND ("last_seen_at" IS NULL OR "last_seen_at" >= "created_at")
        );

ALTER TABLE "public"."access_tokens"
    ADD CONSTRAINT "access_tokens_hash_check"
        CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT "access_tokens_timestamps_check"
        CHECK (
            "expires_at" > "created_at"
            AND (
                "used_at" IS NULL
                OR ("used_at" >= "created_at" AND "used_at" <= "expires_at")
            )
            AND ("revoked_at" IS NULL OR "revoked_at" >= "created_at")
        );

ALTER TABLE "public"."categories"
    ADD CONSTRAINT "categories_name_not_blank_check"
        CHECK (length(btrim("name")) > 0);

ALTER TABLE "public"."suppliers"
    ADD CONSTRAINT "suppliers_name_not_blank_check"
        CHECK (length(btrim("name")) > 0),
    ADD CONSTRAINT "suppliers_lead_time_check"
        CHECK (
            "replenishment_lead_time_days" IS NULL
            OR "replenishment_lead_time_days" >= 0
        );

ALTER TABLE "public"."customers"
    ADD CONSTRAINT "customers_name_not_blank_check"
        CHECK (length(btrim("name")) > 0);

-- PostgreSQL numeric treats NaN as greater than finite values, so >= 0 alone
-- does not exclude it. Precision-constrained numeric also rejects infinities.
ALTER TABLE "public"."products"
    ADD CONSTRAINT "products_sku_normalized_check"
        CHECK (length("sku") > 0 AND "sku" = upper(btrim("sku"))),
    ADD CONSTRAINT "products_barcode_not_blank_check"
        CHECK (
            "barcode" IS NULL
            OR (length("barcode") > 0 AND "barcode" = btrim("barcode"))
        ),
    ADD CONSTRAINT "products_name_not_blank_check"
        CHECK (length(btrim("name")) > 0),
    ADD CONSTRAINT "products_unit_not_blank_check"
        CHECK (length(btrim("unit_of_measure")) > 0),
    ADD CONSTRAINT "products_values_nonnegative_check"
        CHECK (
            "minimum_stock" >= 0 AND "minimum_stock" <> 'NaN'::numeric
            AND "acquisition_cost" >= 0 AND "acquisition_cost" <> 'NaN'::numeric
            AND "sale_price" >= 0 AND "sale_price" <> 'NaN'::numeric
            AND "safety_stock" >= 0 AND "safety_stock" <> 'NaN'::numeric
        ),
    ADD CONSTRAINT "products_lead_time_check"
        CHECK (
            "replenishment_lead_time_days" IS NULL
            OR "replenishment_lead_time_days" >= 0
        );

ALTER TABLE "public"."stock_balances"
    ADD CONSTRAINT "stock_balances_quantity_check"
        CHECK ("quantity" >= 0 AND "quantity" <> 'NaN'::numeric),
    ADD CONSTRAINT "stock_balances_version_check"
        CHECK ("version" >= 0);

ALTER TABLE "public"."stock_movements"
    ADD CONSTRAINT "stock_movements_quantities_check"
        CHECK (
            "quantity_delta" <> 0 AND "quantity_delta" <> 'NaN'::numeric
            AND "quantity_before" >= 0 AND "quantity_before" <> 'NaN'::numeric
            AND "quantity_after" >= 0 AND "quantity_after" <> 'NaN'::numeric
            AND "quantity_after" = "quantity_before" + "quantity_delta"
        ),
    ADD CONSTRAINT "stock_movements_direction_check"
        CHECK (
            ("type" IN ('ENTRY', 'POSITIVE_ADJUSTMENT') AND "quantity_delta" > 0)
            OR ("type" IN ('EXIT', 'NEGATIVE_ADJUSTMENT') AND "quantity_delta" < 0)
            OR "type" = 'COMPENSATION'
        ),
    ADD CONSTRAINT "stock_movements_costs_nonnegative_check"
        CHECK (
            "historical_unit_cost" >= 0
            AND "historical_unit_cost" <> 'NaN'::numeric
            AND "historical_total_cost" >= 0
            AND "historical_total_cost" <> 'NaN'::numeric
        ),
    ADD CONSTRAINT "stock_movements_prices_nonnegative_check"
        CHECK (
            (
                "historical_unit_price" IS NULL
                OR (
                    "historical_unit_price" >= 0
                    AND "historical_unit_price" <> 'NaN'::numeric
                )
            )
            AND (
                "historical_total_price" IS NULL
                OR (
                    "historical_total_price" >= 0
                    AND "historical_total_price" <> 'NaN'::numeric
                )
            )
        ),
    ADD CONSTRAINT "stock_movements_price_pair_check"
        CHECK (
            ("historical_unit_price" IS NULL) = ("historical_total_price" IS NULL)
            AND ("type" <> 'EXIT' OR "historical_unit_price" IS NOT NULL)
        ),
    ADD CONSTRAINT "stock_movements_justification_check"
        CHECK (
            "type" NOT IN ('POSITIVE_ADJUSTMENT', 'NEGATIVE_ADJUSTMENT', 'COMPENSATION')
            OR (
                "justification" IS NOT NULL
                AND length(btrim("justification")) > 0
            )
        ),
    ADD CONSTRAINT "stock_movements_compensation_reference_check"
        CHECK (
            ("type" = 'COMPENSATION' AND "compensates_movement_id" IS NOT NULL)
            OR ("type" <> 'COMPENSATION' AND "compensates_movement_id" IS NULL)
        ),
    ADD CONSTRAINT "stock_movements_compensation_not_self_check"
        CHECK ("compensates_movement_id" IS NULL OR "compensates_movement_id" <> "id"),
    ADD CONSTRAINT "stock_movements_idempotency_key_check"
        CHECK (
            length("idempotency_key") > 0
            AND "idempotency_key" = btrim("idempotency_key")
        );

-- The existing unique constraint on compensates_movement_id prevents two
-- direct compensations for the same original movement. Matching product,
-- inverse quantity, historical values and non-compensation original movement
-- require transactional cross-row validation in stage 4, not a CHECK here.
ALTER TABLE "public"."product_value_history"
    ADD CONSTRAINT "product_value_history_values_check"
        CHECK (
            (
                "previous_value" IS NULL
                OR ("previous_value" >= 0 AND "previous_value" <> 'NaN'::numeric)
            )
            AND "new_value" >= 0 AND "new_value" <> 'NaN'::numeric
        );

ALTER TABLE "public"."audit_events"
    ADD CONSTRAINT "audit_events_entity_type_not_blank_check"
        CHECK (length(btrim("entity_type")) > 0),
    ADD CONSTRAINT "audit_events_entity_id_not_blank_check"
        CHECK ("entity_id" IS NULL OR length(btrim("entity_id")) > 0);

CREATE FUNCTION "public"."reject_history_mutation"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
    RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = format(
            '%I.%I preserves confirmed history; %s is forbidden',
            TG_TABLE_SCHEMA,
            TG_TABLE_NAME,
            TG_OP
        );
END;
$function$;

CREATE TRIGGER "stock_movements_append_only"
BEFORE UPDATE OR DELETE ON "public"."stock_movements"
FOR EACH ROW EXECUTE FUNCTION "public"."reject_history_mutation"();

CREATE TRIGGER "product_value_history_append_only"
BEFORE UPDATE OR DELETE ON "public"."product_value_history"
FOR EACH ROW EXECUTE FUNCTION "public"."reject_history_mutation"();

CREATE TRIGGER "audit_events_append_only"
BEFORE UPDATE OR DELETE ON "public"."audit_events"
FOR EACH ROW EXECUTE FUNCTION "public"."reject_history_mutation"();

-- Roles and credentials are provisioned outside migrations. Listing domain
-- tables explicitly avoids giving the runtime access to _prisma_migrations.
-- TRUNCATE is deliberately not granted to the runtime role.
DO $privileges$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'prevision_app') THEN
        GRANT USAGE ON SCHEMA "public" TO "prevision_app";

        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
            "public"."environment_sentinel",
            "public"."users",
            "public"."roles",
            "public"."permissions",
            "public"."role_permissions",
            "public"."auth_accounts",
            "public"."login_sessions",
            "public"."access_tokens",
            "public"."categories",
            "public"."suppliers",
            "public"."customers",
            "public"."products",
            "public"."stock_balances",
            "public"."stock_movements",
            "public"."product_value_history",
            "public"."audit_events"
        TO "prevision_app";

        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "public" TO "prevision_app";

        REVOKE UPDATE, DELETE ON TABLE
            "public"."stock_movements",
            "public"."product_value_history",
            "public"."audit_events"
        FROM "prevision_app";

        REVOKE INSERT, UPDATE, DELETE ON TABLE "public"."environment_sentinel"
        FROM "prevision_app";
    END IF;
END;
$privileges$;

COMMIT;
