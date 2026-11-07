import "server-only";
import { Prisma } from "../../generated/prisma/client.ts";
import type { AnalysisDTO, AnalysisFilters } from "../../lib/analyses/types.ts";
import { ApplicationError } from "../errors/application-error.ts";
import { buildAnalysis, type AnalysisProductSource } from "./calculations.ts";
import { analysisTimeZone } from "./validation.ts";

type Source = { generatedAt: string; asOfDate: string; products: AnalysisProductSource[] };

/** One database statement returns the complete cohort and its statistics from
 * one snapshot. Filtering is applied before analysis, never after ranking. */
export async function loadAnalysisData(tx: Prisma.TransactionClient, filters: AnalysisFilters): Promise<AnalysisDTO> {
  const clauses: Prisma.Sql[] = [];
  if (filters.status !== "all") clauses.push(Prisma.sql`p.is_active=${filters.status === "active"}`);
  if (filters.search) {
    const pattern = `%${filters.search.replace(/[!%_]/gu, (character) => `!${character}`)}%`;
    clauses.push(Prisma.sql`(p.name ILIKE ${pattern} ESCAPE '!' OR p.sku ILIKE ${pattern} ESCAPE '!' OR p.barcode ILIKE ${pattern} ESCAPE '!')`);
  }
  const where = clauses.length ? Prisma.sql`WHERE ${Prisma.join(clauses, " AND ")}` : Prisma.empty;
  const [record] = await tx.$queryRaw<Source[]>`WITH parameters AS MATERIALIZED (
    SELECT ${filters.from}::date AS start_date,${filters.to}::date AS end_date,
      ${analysisTimeZone}::text AS zone,statement_timestamp() AS as_of
  ), bounds AS MATERIALIZED (
    SELECT *,start_date::timestamp AT TIME ZONE zone AS start_time,
      (end_date+1)::timestamp AT TIME ZONE zone AS end_time FROM parameters
  ), cohort AS MATERIALIZED (
    SELECT p.id,p.name,p.sku,p.unit_of_measure AS unit,p.is_active,p.created_at,
      p.minimum_stock,p.safety_stock,b.quantity,p.replenishment_lead_time_days AS product_lead,
      s.id AS supplier_id,s.name AS supplier_name,s.is_active AS supplier_active,
      s.replenishment_lead_time_days AS supplier_lead,
      greatest(t.start_date,(p.created_at AT TIME ZONE t.zone)::date) AS observation_start
    FROM products p LEFT JOIN stock_balances b ON b.product_id=p.id
    LEFT JOIN suppliers s ON s.id=p.default_supplier_id CROSS JOIN bounds t
    ${where} ORDER BY p.name ASC,p.id ASC LIMIT 1001
  ), ledger AS MATERIALIZED (
    SELECT m.product_id,sum(m.quantity_delta) AS quantity
    FROM stock_movements m JOIN cohort p ON p.id=m.product_id GROUP BY m.product_id
  ), events AS MATERIALIZED (
    SELECT m.product_id,m.type,m.occurred_at,(m.occurred_at AT TIME ZONE b.zone)::date AS day,
      CASE WHEN m.type='EXIT' THEN -m.quantity_delta ELSE 0 END AS exit_quantity,
      CASE WHEN m.type='COMPENSATION' THEN m.quantity_delta ELSE 0 END AS reversed_quantity,
      CASE WHEN m.type='EXIT' THEN m.historical_total_cost ELSE 0 END AS exit_cost,
      CASE WHEN m.type='COMPENSATION' THEN m.historical_total_cost ELSE 0 END AS reversed_cost,
      p.observation_start
    FROM stock_movements m JOIN cohort p ON p.id=m.product_id
    LEFT JOIN stock_movements original ON original.id=m.compensates_movement_id CROSS JOIN bounds b
    WHERE m.occurred_at>=b.start_time AND m.occurred_at<b.end_time
      AND (m.type='EXIT' OR (m.type='COMPENSATION' AND original.type='EXIT'))
  ), totals AS MATERIALIZED (
    SELECT product_id,sum(exit_quantity) AS exit_quantity,sum(reversed_quantity) AS reversed_quantity,
      sum(exit_cost) AS exit_cost,sum(reversed_cost) AS reversed_cost,
      coalesce(sum(exit_quantity) FILTER(WHERE day>=observation_start),0) AS forecast_exit,
      coalesce(sum(reversed_quantity) FILTER(WHERE day>=observation_start),0) AS forecast_reversed
    FROM events GROUP BY product_id
  ), daily AS MATERIALIZED (
    SELECT product_id,day,sum(exit_quantity-reversed_quantity) AS quantity
    FROM events WHERE day>=observation_start GROUP BY product_id,day
  ), positive_days AS (
    SELECT product_id,count(*) FILTER(WHERE quantity>0)::int AS positive_days FROM daily GROUP BY product_id
  ), rows AS (
    SELECT p.id,p.name,p.sku,p.unit,p.is_active AS "isActive",p.quantity::text AS quantity,
      p.minimum_stock::text AS "minimumStock",p.safety_stock::text AS "safetyStock",
      (p.quantity IS NULL OR p.quantity<>coalesce(l.quantity,0)) AS "invalidBalance",
      CASE WHEN p.supplier_id IS NULL THEN NULL ELSE jsonb_build_object('id',p.supplier_id,'name',p.supplier_name,'isActive',p.supplier_active) END AS supplier,
      coalesce(p.product_lead,p.supplier_lead) AS "leadTimeDays",
      CASE WHEN p.product_lead IS NOT NULL THEN 'product' WHEN p.supplier_lead IS NOT NULL THEN 'supplier' ELSE NULL END AS "leadTimeSource",
      greatest(0,b.end_date-p.observation_start+1)::int AS "observedDays",coalesce(d.positive_days,0) AS "positiveExitDays",
      coalesce(t.exit_quantity,0)::text AS "grossExitQuantity",coalesce(t.reversed_quantity,0)::text AS "reversedExitQuantity",
      coalesce(t.exit_cost,0)::text AS "grossExitCost",coalesce(t.reversed_cost,0)::text AS "reversedExitCost",
      coalesce(t.forecast_exit,0)::text AS "forecastExitQuantity",coalesce(t.forecast_reversed,0)::text AS "forecastReversedExitQuantity",
      EXISTS(SELECT 1 FROM audit_events a WHERE a.entity_type='Product' AND a.entity_id=p.id::text AND a.module='PRODUCTS'
        AND a.created_at>=b.start_time AND a.created_at<=b.as_of
        AND a.previous_values->>'unitOfMeasure' IS NOT NULL AND a.new_values->>'unitOfMeasure' IS NOT NULL
        AND a.previous_values->>'unitOfMeasure'<>a.new_values->>'unitOfMeasure') AS "unitChanged"
    FROM cohort p CROSS JOIN bounds b LEFT JOIN ledger l ON l.product_id=p.id
    LEFT JOIN totals t ON t.product_id=p.id LEFT JOIN positive_days d ON d.product_id=p.id
  ) SELECT to_char(b.as_of AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "generatedAt",
    to_char(b.as_of AT TIME ZONE b.zone,'YYYY-MM-DD') AS "asOfDate",
    coalesce((SELECT jsonb_agg(rows ORDER BY rows.name ASC,rows.id ASC) FROM rows),'[]'::jsonb) AS products
    FROM bounds b`;
  if (!record) throw new ApplicationError("UNAVAILABLE", "Não foi possível consultar os dados das análises.");
  return buildAnalysis(record.products, filters, record.generatedAt, record.asOfDate);
}
