#!/bin/sh
set -eu

psql --set=ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=app_password="$POSTGRES_APP_PASSWORD" <<'SQL'
CREATE ROLE prevision_app LOGIN PASSWORD :'app_password';
GRANT CONNECT ON DATABASE prevision_dev TO prevision_app;
GRANT USAGE ON SCHEMA public TO prevision_app;
-- As migrations concedem acesso somente às tabelas de domínio.
-- Não conceder privilégios padrão que incluam _prisma_migrations.
SQL
