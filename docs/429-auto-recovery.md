# Automatic recovery for HTTP 429 accounts

Accounts disabled by a new HTTP 429 in the shared account-error handler now
receive a persistent rateLimitRecovery marker. HTTP 401 still disables the
account but cancels recovery. Manually changing Active also cancels recovery.

The Node server starts the worker without requiring a dashboard request. It
checks after 10 seconds, then every 60 seconds. Due accounts are processed in
batches of 10, after all stored model cooldowns expire. Each quota check has a
30-second deadline. Errors/unknown quota data leave the account disabled and
retry after 1, 2, 4, 8, then 15 minutes (capped), or at the later provider reset.

Supported usage APIs are queried with existing proxy and OAuth refresh handling.
Codex checks the relevant regular/review/spark pool; Antigravity checks the
requested model and available family summaries. Exhausted or incomplete quota
data never counts as a successful recovery.

When quota is available, the worker enables the account and clears the old
cooldown/error state. Providers without a usage API become eligible for the next
real request after cooldown; no synthetic chat/image request is sent. Their
backoff is retained until a real request succeeds, and another 429 disables
them again.

Schedules and retry counts are stored in the existing connection JSON in SQLite;
no schema migration is needed. Conditional transactional updates and expiring
worker claims protect against duplicate workers, new 401/429 errors and manual
toggles during a quota check. A restart resumes the saved schedule.

Existing inactive accounts without this marker are not automatically enrolled:
they cannot reliably be distinguished from accounts disabled manually. To opt
one back into normal routing, enable it manually once; a subsequent 429 will
create its recovery schedule. The Antigravity chat path that uses only an
in-memory model quota cache is unchanged.

Restart the application after updating to start the worker. No dashboard
setting, external cron job or new dependency is required. The server must stay
running for scheduled checks; after downtime, due work resumes on startup.

Configuration: src/shared/constants/rateLimitRecovery.js.

Tests: from tests/, run npm test -- unit/rate-limit-recovery.test.js
unit/rate-limit-recovery-startup.test.js unit/rate-limit-recovery-persistence.test.js
unit/antigravity-account-cooldown.test.js.
