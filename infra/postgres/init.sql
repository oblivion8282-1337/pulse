-- Create per-service schemas. Each service owns its schema and runs its own
-- Alembic migrations within it.
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS chat;
