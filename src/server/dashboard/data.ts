import "server-only";
import { Prisma } from "../../generated/prisma/client.ts";
import type { DashboardDTO, DashboardPeriod } from "../../lib/dashboard/types.ts";
import { ApplicationError } from "../errors/application-error.ts";
import { dashboardBuckets } from "./validation.ts";

/** Fixed formatting of already rounded PostgreSQL NUMERIC text. No floating
 * point conversion or Decimal precision context may round large sums here. */
export function dashboardFixed(value: string, places: number): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(value);
  if (!match || (match[3] ?? "").slice(places).replace(/0/gu, "")) throw new ApplicationError("UNAVAILABLE", "Não foi possível conferir a precisão dos indicadores.");
  const whole = match[2].replace(/^0+(?=\d)/u, "");
  const fraction = (match[3] ?? "").slice(0, places).padEnd(places, "0");
  const sign = /[1-9]/u.test(whole + fraction) ? match[1] : "";
  return `${sign}${whole}.${fraction}`;
}

export const dashboardWarnings = [
  "O estoque atual considera todos os produtos, inclusive inativos. Estoque baixo e sem estoque consideram somente produtos ativos.",
  "Entradas e saídas usam a data da operação e os valores históricos brutos dos lançamentos originais. Ajustes e compensações são apresentados separadamente; uma compensação não apaga o lançamento original.",
  "A evolução é uma reconstrução pelos horários de registro armazenados: saldo dos movimentos registrados e custo de aquisição vigente em cada fechamento. Datas de operação retroativas não antecipam o registro. Registros antigos com horários empatados podem exigir conferência do histórico.",
  "Valores de estoque e venda potencial são estimativas de cadastro, não lucro realizado ou custo médio contábil. Cada produto é arredondado em centavos antes da soma.",
  "As quantidades do período são agrupadas pela unidade atual do cadastro. Uma alteração posterior da unidade não reescreve os movimentos; confira o histórico de cada produto quando necessário."
];

type QueryResult = Omit<DashboardDTO, "period" | "warnings"> & { integrity: { invalidBalances: number; invalidCosts: number; missingHistoricalCosts: number; negativeHistoricalBalances: number; ambiguousHistoricalCosts: number } };

/** One data statement also gives a coherent PostgreSQL snapshot if privileged
 * maintenance changes a source without using the application's write locks. */
export async function loadDashboardData(tx: Prisma.TransactionClient, period: DashboardPeriod): Promise<DashboardDTO> {
  const buckets = JSON.stringify(dashboardBuckets(period));
  const [record] = await tx.$queryRaw<QueryResult[]>`WITH parameters AS MATERIALIZED (
    SELECT ${period.from}::date AS start_date, ${period.to}::date AS end_date,
      ${period.timeZone}::text AS zone, statement_timestamp() AS as_of
  ), bounds AS (
    SELECT *, start_date::timestamp AT TIME ZONE zone AS start_time,
      (end_date+1)::timestamp AT TIME ZONE zone AS end_time FROM parameters
  ), buckets AS MATERIALIZED (
    SELECT (entry->>'from')::date AS start_date, (entry->>'to')::date AS end_date,
      (entry->>'from')::date::timestamp AT TIME ZONE b.zone AS start_time,
      ((entry->>'to')::date+1)::timestamp AT TIME ZONE b.zone AS end_time,
      least(((entry->>'to')::date+1)::timestamp AT TIME ZONE b.zone,b.as_of) AS cutoff
    FROM bounds b CROSS JOIN jsonb_array_elements(${buckets}::jsonb) AS entry
  ), ledger_totals AS MATERIALIZED (
    SELECT product_id,sum(quantity_delta) AS quantity FROM stock_movements GROUP BY product_id
  ), current_products AS MATERIALIZED (
    SELECT p.id,p.name,p.sku,p.unit_of_measure AS unit,p.is_active,p.category_id,p.created_at,p.acquisition_cost,
      b.quantity,round(b.quantity*p.acquisition_cost,2) AS cost,round(b.quantity*p.sale_price,2) AS sale,
      p.minimum_stock,coalesce(l.quantity,0) AS ledger_quantity,
      h.new_value AS latest_cost,h.ambiguous AS ambiguous_cost
    FROM products p LEFT JOIN stock_balances b ON b.product_id=p.id LEFT JOIN ledger_totals l ON l.product_id=p.id
    LEFT JOIN LATERAL (
      SELECT v.new_value,min(v.new_value) OVER (PARTITION BY v.effective_at,v.created_at)<>max(v.new_value) OVER (PARTITION BY v.effective_at,v.created_at) AS ambiguous
      FROM product_value_history v CROSS JOIN bounds t
      WHERE v.product_id=p.id AND v.type='ACQUISITION_COST' AND v.effective_at<t.as_of AND v.created_at<t.as_of
      ORDER BY v.effective_at DESC,v.created_at DESC,v.id DESC LIMIT 1
    ) h ON true
  ), period_movements AS MATERIALIZED (
    SELECT m.*,p.unit_of_measure AS unit,p.name,p.sku FROM stock_movements m
    JOIN products p ON p.id=m.product_id CROSS JOIN bounds b
    WHERE m.occurred_at>=b.start_time AND m.occurred_at<b.end_time
  ), historical_products AS MATERIALIZED (
    SELECT b.start_date,b.end_date,p.id,coalesce(q.quantity,0) AS quantity,h.new_value AS cost,h.ambiguous
    FROM buckets b JOIN products p ON p.created_at<b.cutoff
    LEFT JOIN LATERAL (
      SELECT sum(m.quantity_delta) AS quantity FROM stock_movements m WHERE m.product_id=p.id AND m.created_at<b.cutoff
    ) q ON true
    LEFT JOIN LATERAL (
      SELECT v.new_value,min(v.new_value) OVER (PARTITION BY v.effective_at,v.created_at)<>max(v.new_value) OVER (PARTITION BY v.effective_at,v.created_at) AS ambiguous
      FROM product_value_history v WHERE v.product_id=p.id AND v.type='ACQUISITION_COST'
        AND v.effective_at<b.cutoff AND v.created_at<b.cutoff
      ORDER BY v.effective_at DESC,v.created_at DESC,v.id DESC LIMIT 1
    ) h ON true
  ), historical_totals AS (
    SELECT start_date,end_date,sum(round(quantity*coalesce(cost,0),2)) AS cost FROM historical_products GROUP BY start_date,end_date
  ), bucket_movements AS (
    SELECT b.start_date,b.end_date,count(*) FILTER(WHERE m.type='ENTRY')::int AS entries,
      count(*) FILTER(WHERE m.type='EXIT')::int AS exits,
      coalesce(sum(m.historical_total_cost) FILTER(WHERE m.type='ENTRY'),0) AS entries_cost,
      coalesce(sum(m.historical_total_cost) FILTER(WHERE m.type='EXIT'),0) AS exits_cost,
      coalesce(sum(m.historical_total_price) FILTER(WHERE m.type='EXIT'),0) AS exits_sale,
      count(*) FILTER(WHERE m.type IN ('POSITIVE_ADJUSTMENT','NEGATIVE_ADJUSTMENT'))::int AS adjustments,
      count(*) FILTER(WHERE m.type='COMPENSATION')::int AS compensations
    FROM buckets b LEFT JOIN period_movements m ON m.occurred_at>=b.start_time AND m.occurred_at<b.end_time GROUP BY b.start_date,b.end_date
  ), category_totals AS MATERIALIZED (
    SELECT c.id,c.name,count(*)::int AS products,sum(p.cost) AS cost,
      row_number() OVER(ORDER BY count(*) DESC,c.name ASC,c.id ASC) AS rank
    FROM current_products p JOIN categories c ON c.id=p.category_id GROUP BY c.id,c.name
  ), category_rows AS (
    SELECT id::text,name,products,cost FROM category_totals WHERE rank<=10
    UNION ALL SELECT 'other','Outras categorias',sum(products)::int,sum(cost) FROM category_totals WHERE rank>10 HAVING count(*)>0
  ) SELECT
    to_char(b.as_of AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "generatedAt",
    (SELECT jsonb_build_object('products',count(*)::int,'activeProducts',count(*) FILTER(WHERE is_active)::int,
      'inactiveProducts',count(*) FILTER(WHERE NOT is_active)::int,
      'lowStock',count(*) FILTER(WHERE is_active AND quantity>0 AND quantity<=minimum_stock)::int,
      'emptyStock',count(*) FILTER(WHERE is_active AND quantity=0)::int,
      'estimatedCost',coalesce(sum(cost),0)::text,'potentialSale',coalesce(sum(sale),0)::text,
      'estimatedMargin',(coalesce(sum(sale),0)-coalesce(sum(cost),0))::text) FROM current_products) AS current,
    (SELECT jsonb_build_object('entries',count(*) FILTER(WHERE type='ENTRY')::int,'exits',count(*) FILTER(WHERE type='EXIT')::int,
      'adjustments',count(*) FILTER(WHERE type IN ('POSITIVE_ADJUSTMENT','NEGATIVE_ADJUSTMENT'))::int,'compensations',count(*) FILTER(WHERE type='COMPENSATION')::int,
      'entriesCost',coalesce(sum(historical_total_cost) FILTER(WHERE type='ENTRY'),0)::text,
      'exitsCost',coalesce(sum(historical_total_cost) FILTER(WHERE type='EXIT'),0)::text,
      'exitsSale',coalesce(sum(historical_total_price) FILTER(WHERE type='EXIT'),0)::text) FROM period_movements) AS movements,
    coalesce((SELECT jsonb_agg(rows ORDER BY rows.unit) FROM (
      SELECT unit,coalesce(sum(quantity_delta) FILTER(WHERE type='ENTRY'),0)::text AS "entryQuantity",
        coalesce(sum(-quantity_delta) FILTER(WHERE type='EXIT'),0)::text AS "exitQuantity",
        coalesce(sum(quantity_delta) FILTER(WHERE type IN ('POSITIVE_ADJUSTMENT','NEGATIVE_ADJUSTMENT')),0)::text AS "adjustmentDelta",
        coalesce(sum(quantity_delta) FILTER(WHERE type='COMPENSATION'),0)::text AS "compensationDelta"
      FROM period_movements GROUP BY unit) rows),'[]'::jsonb) AS units,
    coalesce((SELECT jsonb_agg(rows ORDER BY rows."from") FROM (
      SELECT m.start_date::text AS "from",m.end_date::text AS "to",m.entries,m.exits,m.adjustments,m.compensations,
        m.entries_cost::text AS "entriesCost",m.exits_cost::text AS "exitsCost",m.exits_sale::text AS "exitsSale",
        coalesce(h.cost,0)::text AS "estimatedStockCost"
      FROM bucket_movements m LEFT JOIN historical_totals h USING(start_date,end_date)) rows),'[]'::jsonb) AS series,
    coalesce((SELECT jsonb_agg(rows ORDER BY rows.movements DESC,rows.name ASC,rows.id ASC) FROM (
      SELECT product_id AS id,name,sku,count(*)::int AS movements,count(*) FILTER(WHERE type='ENTRY')::int AS entries,
        count(*) FILTER(WHERE type='EXIT')::int AS exits,coalesce(sum(historical_total_cost) FILTER(WHERE type='EXIT'),0)::text AS "exitCost"
      FROM period_movements WHERE type IN ('ENTRY','EXIT') GROUP BY product_id,name,sku ORDER BY count(*) DESC,name ASC,product_id ASC LIMIT 10
    ) rows),'[]'::jsonb) AS "mostMoved",
    coalesce((SELECT jsonb_agg(to_jsonb(rows)-'order_cost' ORDER BY rows.order_cost DESC,rows.id ASC) FROM (
      SELECT id,name,sku,unit,is_active AS "isActive",quantity::text AS quantity,cost::text AS "estimatedCost",sale::text AS "potentialSale",cost AS order_cost
      FROM current_products WHERE quantity>0 ORDER BY cost DESC,id ASC LIMIT 10
    ) rows),'[]'::jsonb) AS "highestValue",
    coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name,'products',products,'estimatedCost',cost::text) ORDER BY (id='other') ASC,products DESC,name ASC,id ASC) FROM category_rows),'[]'::jsonb) AS categories,
    jsonb_build_object('invalidBalances',(SELECT count(*)::int FROM current_products WHERE quantity IS NULL OR quantity<>ledger_quantity),
      'invalidCosts',(SELECT count(*)::int FROM current_products WHERE latest_cost<>acquisition_cost OR ambiguous_cost OR (latest_cost IS NULL AND quantity>0)),
      'missingHistoricalCosts',(SELECT count(*)::int FROM historical_products WHERE quantity>0 AND cost IS NULL),
      'negativeHistoricalBalances',(SELECT count(*)::int FROM historical_products WHERE quantity<0),
      'ambiguousHistoricalCosts',(SELECT count(*)::int FROM historical_products WHERE quantity>0 AND ambiguous)) AS integrity
    FROM bounds b`;
  if (!record) throw new ApplicationError("UNAVAILABLE", "Não foi possível consultar os indicadores.");
  if (Object.values(record.integrity).some((count) => count !== 0)) throw new ApplicationError("UNAVAILABLE", "O saldo ou o histórico de custos precisa ser conferido antes de apresentar os indicadores.");
  const money = (value: string) => dashboardFixed(value, 2);
  const quantity = (value: string) => dashboardFixed(value, 4);
  return {
    generatedAt: record.generatedAt, period,
    current: { ...record.current, estimatedCost: money(record.current.estimatedCost), potentialSale: money(record.current.potentialSale), estimatedMargin: money(record.current.estimatedMargin) },
    movements: { ...record.movements, entriesCost: money(record.movements.entriesCost), exitsCost: money(record.movements.exitsCost), exitsSale: money(record.movements.exitsSale) },
    units: record.units.map((item) => ({ ...item, entryQuantity: quantity(item.entryQuantity), exitQuantity: quantity(item.exitQuantity), adjustmentDelta: quantity(item.adjustmentDelta), compensationDelta: quantity(item.compensationDelta) })),
    series: record.series.map((point) => ({ ...point, entriesCost: money(point.entriesCost), exitsCost: money(point.exitsCost), exitsSale: money(point.exitsSale), estimatedStockCost: money(point.estimatedStockCost) })),
    mostMoved: record.mostMoved.map((item) => ({ ...item, exitCost: money(item.exitCost) })),
    highestValue: record.highestValue.map((item) => ({ id: item.id, name: item.name, sku: item.sku, unit: item.unit, isActive: item.isActive, quantity: quantity(item.quantity), estimatedCost: money(item.estimatedCost), potentialSale: money(item.potentialSale) })),
    categories: record.categories.map((item) => ({ ...item, estimatedCost: money(item.estimatedCost) })),
    warnings: [...dashboardWarnings]
  };
}
