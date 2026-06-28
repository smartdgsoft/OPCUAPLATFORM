#!/bin/bash
# Setup streaming replication user on primary
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE USER replicator WITH REPLICATION ENCRYPTED PASSWORD '${POSTGRES_REPLICATION_PASSWORD:-repl_pass_change}';
    SELECT pg_create_physical_replication_slot('replica_slot_1');
EOSQL

# Allow replication connections in pg_hba.conf
echo "host replication replicator 0.0.0.0/0 md5" >> "$PGDATA/pg_hba.conf"
