# ADR-0033: Durable Better Auth audit events

## Status

Accepted — 2026-09-09

## Decision

Add the additive migration `0033_auth_audit_events.sql` and record the three
security events needed for Go Live:

- `login_success`
- `login_failure`
- `logout`

The application records events from Better Auth's lifecycle hooks, after the
underlying session transaction has completed. Login failures are captured from
the Better Auth endpoint after it returns an authentication error. Audit write
failures are logged server-side and never turn a successful login/logout into a
failed request.

The ledger keeps a nullable `user_id` with `on delete set null`, the normalized
email when it is available, the Better Auth session id as a non-FK historical
identifier, bounded request metadata, and a JSON object for non-sensitive
context. Passwords, cookies, bearer/session tokens, API keys, and request
bodies are explicitly out of scope and must not be stored.

## Rationale

Better Auth's `public.session` table is current-state session storage, not an
audit history. Deleting a session during logout therefore cannot provide a
durable security trail by itself. A separate append-only ledger preserves the
event after the session row is removed and survives user deletion without
destroying the historical record.

## Consequences

- This is an additive schema change; no existing Better Auth table is altered.
- Migration ceiling advances from 0032 to 0033 and the release validator must
  admit this migration only with this ADR and its exact source checksum.
- Retention of IP address and user-agent data must follow Verity's internal
  security/privacy policy. No automatic purge policy is introduced here.
- The first Go Live integration gate must execute against PostgreSQL and prove
  login failure, login success, session lookup, logout, and durable ledger
  persistence.

