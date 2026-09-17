# DeepWell database migrations

The migrations run from a machine that can reach Neon. `run-migration-v2.js`
applies exactly **one** file per invocation, so the order below is the order you
type — nothing enforces it for you.

## Run order

Filename order is the run order. This matters more than it looks:

| # | File | What it does |
|---|---|---|
| 1 | `01-create-schema.sql` | Tables, indexes, RLS policies |
| 2 | `01b-app-role.sql` | Creates `deepwell_rls`, the role the app connects as |
| 3 | `02-tenancy-fix.sql` | FORCE RLS, `resolve_tenant()`, the old `deepwell_app` role |
| 4 | `03-retrieval.sql` | Full-text search, trigram indexes, grants |
| 5 | `04-cleanup.sql` | Drops `deepwell_app` and `deepwell_probe` |
| 6 | `05-customer-link.sql` | `entities.customer_id` plus its guard trigger |
| 7 | `06-warranty-indexes.sql` | Partial expression indexes for the warranty queries |

`01b` is numbered the way it is deliberately. It has to exist before `04` drops
the older role, or there is a window where the application has no working
database role at all.

Every file is safe to run twice.

## On an existing database

`01` through `05` have already been applied to production. Outstanding:

- **`06-warranty-indexes.sql`** — not yet run. Adds the indexes behind the
  warranty-attention query. Run it off-hours; it takes a brief lock on
  `entities`.
- **`01b-app-role.sql`** — production already *has* `deepwell_rls`, so this is a
  no-op there. It exists so the set can rebuild the database from nothing.
  Before trusting it for that, compare it against the live role:

  ```sql
  SELECT rolname, rolsuper, rolbypassrls, rolcanlogin, rolconnlimit
    FROM pg_roles WHERE rolname = 'deepwell_rls';
  ```

  `rolbypassrls` must be **false**. If it is true, every tenant-isolation
  guarantee in the application is decoration — a role with BYPASSRLS reads every
  tenant's rows regardless of any policy.

## Prerequisites

- Node 18+
- `npm install pg`
- `NEON_CONNECTION_STRING` in `.env.local` at the project root

## Running one file

```bash
NEON_CONNECTION_STRING='postgresql://USER:PASSWORD@HOST.neon.tech/neondb?sslmode=require' \
SCHEMA_FILE=./M3-config/06-warranty-indexes.sql \
node M3-config/run-migration-v2.js
```

Repeat with each file in the table order.

## Roles

| Role | Status |
|---|---|
| `deepwell_rls` | The one the application uses. `NOBYPASSRLS`, no DDL rights. |
| `deepwell_app` | Superseded. Dropped by `04`. |
| `deepwell_probe` | Superseded. Dropped by `04`. |

Dropping a role via SQL fails on Neon with "permission denied to drop objects".
Use the **Roles** page in the Neon console instead.
