-- ============================================================================
-- Migration 20260921000001: ENCRYPTED RECOVERABLE INTAKE TOKENS
--
-- Adds encrypted-at-rest storage for intake window tokens so authorized
-- coordinators can copy the SAME public link later (without rotating).
--
-- Architecture:
--   token_hash     = SHA-256 hex (unchanged, used for validation)
--   encrypted_token = AES-256-GCM ciphertext (hex)
--   encryption_iv   = 96-bit nonce (hex)
--   encryption_tag  = 128-bit auth tag (hex)
-- Encryption key: server-only env var INTAKE_TOKEN_ENCRYPTION_KEY (64-char hex)
-- ============================================================================

alter table public.intake_windows
  add column if not exists encrypted_token text;
alter table public.intake_windows
  add column if not exists encryption_iv text;
alter table public.intake_windows
  add column if not exists encryption_tag text;
