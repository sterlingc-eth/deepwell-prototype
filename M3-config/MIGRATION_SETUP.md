# M3 Postgres Migration - Local Setup

The schema migration needs to run from your local machine where network connectivity to Neon is available.

## Files you need

1. **01-create-schema.sql** - The Postgres schema file (all tables and RLS policies)
2. **run-migration-v2.js** - The migration runner script
3. This setup guide

## Prerequisites

1. Node.js 18+ installed on your machine
2. `.env.local` file in your deepwell root with `NEON_CONNECTION_STRING`
3. The `pg` npm package

## Steps

### 1. Install dependencies

From your deepwell root:

```bash
npm install pg
```

### 2. Set up environment

Make sure your `.env.local` has the Neon connection string:

```
NEON_CONNECTION_STRING=postgresql://neondb_owner:npg_51lRW5rTQqIIap-rapid-rice-axqd45ey-pooler.c-4.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require
```

### 3. Run the migration

```bash
# From deepwell root
NEON_CONNECTION_STRING=$(grep NEON_CONNECTION_STRING .env.local | cut -d= -f2) \
SCHEMA_FILE=./M3-config/01-create-schema.sql \
node run-migration-v2.js
```

Or on Windows (PowerShell):

```powershell
$env:NEON_CONNECTION_STRING = (Get-Content .env.local | Select-String "NEON_CONNECTION_STRING" | ForEach-Object { $_ -replace ".*=", "" })
$env:SCHEMA_FILE = ".\M3-config\01-create-schema.sql"
node run-migration-v2.js
```

## Expected output

```
Connecting to Neon...
✓ Connected

Running schema migration...
✓ Schema created

Verifying tables...
✓ Created 10 tables:
  ├─ audit_log
  ├─ document_pages
  ├─ documents
  ├─ entities
  ├─ extractions
  ├─ facets
  ├─ proposals
  ├─ schema_versions
  ├─ tenants
  ├─ users

Verifying Row-Level Security...
✓ RLS enabled on 9/10 tables

✅ Migration complete. Postgres schema is ready for M3.
```

## Troubleshooting

**Connection timeout:**
- Check your internet connection
- Verify Neon is online (log in to Neon console)
- Check if your ISP/network blocks port 5432

**Authentication error:**
- Verify the connection string in `.env.local` is correct
- Check if credentials were copied exactly (no extra spaces)

**Table creation fails:**
- Make sure you have admin access to the Neon database
- Check if the database already has existing tables (migration tries to create)

## Next steps after migration

Once migration completes successfully:
1. Verify all 10 tables exist in your Neon console
2. We'll build the Postgres `RecordsStore` implementation to replace IndexedDB
3. Test the 8-step pipeline against Postgres

