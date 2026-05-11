-- Create per-service schemas. Each service owns its schema and runs its own
-- Alembic migrations within it.
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS chat;

-- Separate database for E2E tests. On existing volumes the globalSetup
-- creates this DB automatically; this line only runs on fresh volumes.
CREATE DATABASE dcc_test;
