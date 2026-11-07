import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { assertDatabaseIdentity, assertLocalDevelopmentDatabase, readEnvironment } from "../../src/server/config/environment.ts";
import { reportDatabaseFailure } from "./shared.ts";

/** Exercita as migrations reais e desfaz todas as fixtures ao terminar. */
async function integration() {
  const environment = readEnvironment();
  assertLocalDevelopmentDatabase(environment);
  if (!environment.DIRECT_URL) throw new Error("Configure DIRECT_URL para administração local.");
  const admin = new Client({ connectionString: environment.DIRECT_URL, connectionTimeoutMillis: 5000 });
  const runtime = new Client({ connectionString: environment.DATABASE_URL, connectionTimeoutMillis: 5000 });
  let verified = 0;
  let transactionStarted = false;

  async function rejects(sql: string, parameters: unknown[], expectedCode: string) {
    await admin.query("SAVEPOINT expected_rejection");
    let receivedCode: string | undefined;
    try { await admin.query(sql, parameters); }
    catch (error) { receivedCode = (error as { code?: string }).code; }
    finally {
      await admin.query("ROLLBACK TO SAVEPOINT expected_rejection");
      await admin.query("RELEASE SAVEPOINT expected_rejection");
    }
    assert.equal(receivedCode, expectedCode, `Restrição esperada: SQLSTATE ${expectedCode}.`);
    verified++;
  }

  try {
    await admin.connect();
    await runtime.connect();
    const identity = await runtime.query<{ environment: string; databaseId: string }>(
      'SELECT environment, database_id AS "databaseId" FROM environment_sentinel WHERE id = $1', ["primary"]
    );
    assertDatabaseIdentity(environment, identity.rows[0] ?? null);

    const privileges = await runtime.query(`SELECT
      current_user AS name,
      has_schema_privilege(current_user, 'public', 'CREATE') AS can_create,
      has_table_privilege(current_user, 'public._prisma_migrations', 'SELECT') AS can_read_migrations,
      has_table_privilege(current_user, 'public._prisma_migrations', 'INSERT,UPDATE,DELETE,TRUNCATE') AS can_write_migrations,
      has_table_privilege(current_user, 'public.environment_sentinel', 'INSERT,UPDATE,DELETE,TRUNCATE') AS can_change_identity,
      has_table_privilege(current_user, 'public.stock_movements', 'UPDATE,DELETE,TRUNCATE') AS can_change_history`);
    const role = privileges.rows[0];
    assert.equal(role.name, "prevision_app", "O runtime deve usar a credencial restrita.");
    for (const key of ["can_create", "can_read_migrations", "can_write_migrations", "can_change_identity", "can_change_history"]) {
      assert.equal(role[key], false, `Privilégio inesperado: ${key}.`);
      verified++;
    }

    await admin.query("BEGIN");
    transactionStarted = true;
    const suffix = randomUUID();
    const categoryId = randomUUID();
    const userId = randomUUID();
    const productId = randomUUID();
    const movementId = randomUUID();
    const auditId = randomUUID();
    const valueHistoryId = randomUUID();
    const sku = `CHECK-${suffix}`.toUpperCase();
    const barcode = `000${suffix.replaceAll("-", "")}`;

    await admin.query('INSERT INTO roles (id, code, name, updated_at) VALUES ($1, $2, $3, now()) ON CONFLICT (code) DO NOTHING', [randomUUID(), "OPERATOR", "Operador"]);
    const roleId = (await admin.query('SELECT id FROM roles WHERE code = $1', ["OPERATOR"])).rows[0].id;
    await admin.query('INSERT INTO users (id, email, role_id, updated_at) VALUES ($1, $2, $3, now())', [userId, `foundation.${suffix}@example.invalid`, roleId]);
    await admin.query('INSERT INTO categories (id, name, updated_at) VALUES ($1, $2, now())', [categoryId, `Validação ${suffix}`]);
    const productSql = 'INSERT INTO products (id, sku, barcode, name, category_id, updated_at) VALUES ($1, $2, $3, $4, $5, now())';
    await admin.query(productSql, [productId, sku, barcode, "Produto de validação", categoryId]);
    await admin.query('INSERT INTO stock_balances (product_id, quantity, updated_at) VALUES ($1, $2, now())', [productId, "2.5001"]);
    const balance = await admin.query('SELECT quantity::text FROM stock_balances WHERE product_id = $1', [productId]);
    assert.equal(balance.rows[0].quantity, "2.5001");
    verified++;
    const product = await admin.query('SELECT barcode FROM products WHERE id = $1', [productId]);
    assert.equal(product.rows[0].barcode, barcode);
    verified++;

    await rejects(productSql, [randomUUID(), sku, null, "Duplicado", categoryId], "23505");
    await rejects(productSql, [randomUUID(), `${sku}-B`, barcode, "Duplicado", categoryId], "23505");
    await admin.query(productSql, [randomUUID(), `${sku}-N1`, null, "Sem código 1", categoryId]);
    await admin.query(productSql, [randomUUID(), `${sku}-N2`, null, "Sem código 2", categoryId]);
    verified++;
    await rejects('UPDATE stock_balances SET quantity = $1 WHERE product_id = $2', ["-1", productId], "23514");
    await rejects("UPDATE stock_balances SET quantity = 'NaN'::numeric WHERE product_id = $1", [productId], "23514");
    await rejects('UPDATE products SET sku = $1 WHERE id = $2', [" sku-sem-normalizar ", productId], "23514");
    await rejects('UPDATE users SET email = $1 WHERE id = $2', ["Email@EXAMPLE.INVALID", userId], "23514");

    const movementSql = `INSERT INTO stock_movements
      (id, product_id, type, quantity_delta, quantity_before, quantity_after,
       historical_unit_cost, historical_total_cost, performed_by_id, operation_id, idempotency_key)
      VALUES ($1, $2, $3::"StockMovementType", $4, $5, $6, $7, $8, $9, $10, $11)`;
    const movement = [movementId, productId, "ENTRY", "2.5001", "0", "2.5001", "2", "5.00", userId, randomUUID(), `check-${suffix}`];
    await admin.query(movementSql, movement);
    await rejects(movementSql, [randomUUID(), ...movement.slice(1)], "23505");
    await rejects(movementSql, [randomUUID(), productId, "ENTRY", "1", "2", "4", "2", "2", userId, randomUUID(), randomUUID()], "23514");
    await rejects(movementSql, [randomUUID(), productId, "ENTRY", "-1", "2", "1", "2", "2", userId, randomUUID(), randomUUID()], "23514");
    await rejects(movementSql, [randomUUID(), productId, "EXIT", "-1", "2", "1", "2", "2", userId, randomUUID(), randomUUID()], "23514");
    await rejects(movementSql, [randomUUID(), productId, "POSITIVE_ADJUSTMENT", "1", "2", "3", "2", "2", userId, randomUUID(), randomUUID()], "23514");

    await admin.query('INSERT INTO audit_events (id, actor_id, action, module, entity_type, entity_id, operation_id) VALUES ($1, $2, $3, $4, $5, $6, $7)', [auditId, userId, "CREATE", "PRODUCTS", "Product", productId, randomUUID()]);
    await admin.query('INSERT INTO product_value_history (id, product_id, type, new_value, changed_by_id, operation_id) VALUES ($1, $2, $3, $4, $5, $6)', [valueHistoryId, productId, "ACQUISITION_COST", "2", userId, randomUUID()]);
    // Identificadores de tabela fixos, nunca derivados de entrada de usuário.
    for (const [table, id] of [["stock_movements", movementId], ["audit_events", auditId], ["product_value_history", valueHistoryId]]) {
      await rejects(`UPDATE ${table} SET id = id WHERE id = $1`, [id], "55000");
      await rejects(`DELETE FROM ${table} WHERE id = $1`, [id], "55000");
    }
    await rejects('DELETE FROM products WHERE id = $1', [productId], "23503");
    await admin.query("SAVEPOINT restricted_role");
    await admin.query("SET LOCAL ROLE prevision_app");
    await rejects('UPDATE environment_sentinel SET environment = environment WHERE id = $1', ["primary"], "42501");
    await rejects('UPDATE stock_movements SET id = id WHERE id = $1', [movementId], "42501");
    await admin.query("ROLLBACK TO SAVEPOINT restricted_role");
    await admin.query("RELEASE SAVEPOINT restricted_role");

    console.info(`${verified} verificações de integração aprovadas: precisão, unicidade, restrições, histórico e permissões.`);
  } finally {
    if (transactionStarted) await admin.query("ROLLBACK");
    await Promise.allSettled([admin.end(), runtime.end()]);
  }
}

integration().catch((error: unknown) => reportDatabaseFailure("Integração interrompida", error));
