#!/usr/bin/env bash
# Se ejecuta UNA vez, al inicializar el volumen. Una base por servicio; roles sin superusuario ni BYPASSRLS.
# Las contraseñas se pasan como variables psql (:'var'), nunca interpoladas en el SQL.
set -euo pipefail
: "${CONTEXTRAG_OWNER_PASSWORD:?}" "${CONTEXTRAG_APP_PASSWORD:?}" "${CLOUDCOST_OWNER_PASSWORD:?}" "${DOCMIND_DB_PASSWORD:?}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v cr_owner="$CONTEXTRAG_OWNER_PASSWORD" -v cr_app="$CONTEXTRAG_APP_PASSWORD" \
  -v cc_owner="$CLOUDCOST_OWNER_PASSWORD" -v dm_pw="$DOCMIND_DB_PASSWORD" <<'SQL'
-- ContextRAG: `contextrag` (propietario, DDL) y `contextrag_app` (runtime, sujeto a RLS)
CREATE ROLE contextrag      LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'cr_owner';
CREATE ROLE contextrag_app  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'cr_app';
CREATE DATABASE contextrag OWNER contextrag ENCODING 'UTF8' TEMPLATE template0;

-- CloudCost: `cloudcost_owner`; el rol `cloudcost_app` lo crea el job `cloudcost-migrate` (sin BYPASSRLS)
CREATE ROLE cloudcost_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'cc_owner';
CREATE DATABASE cloudcost OWNER cloudcost_owner ENCODING 'UTF8' TEMPLATE template0;

-- DocMind
CREATE ROLE docmind LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'dm_pw';
CREATE DATABASE docmind OWNER docmind ENCODING 'UTF8' TEMPLATE template0;

-- Nadie, salvo el propietario, se conecta a la base de otro servicio
REVOKE ALL ON DATABASE contextrag, cloudcost, docmind FROM PUBLIC;
GRANT CONNECT ON DATABASE contextrag TO contextrag_app;
SQL

# Extensiones: las crea el superusuario (el propietario no puede). pgvector es opcional (ContextRAG degrada a float8[]).
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname contextrag -c 'CREATE EXTENSION IF NOT EXISTS vector' \
  || echo "aviso: pgvector no disponible; ContextRAG usará float8[]"
for db in contextrag cloudcost docmind; do
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto'
done
