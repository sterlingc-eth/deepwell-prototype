#!/usr/bin/env node

/**
 * M3 Postgres Schema Migration Runner (v2)
 * Uses manual connection parameters instead of connection string
 */

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const connString = process.env.NEON_CONNECTION_STRING;
const schemaFile = process.env.SCHEMA_FILE || path.join(__dirname, '01-create-schema.sql');

if (!connString) {
  console.error('❌ Missing NEON_CONNECTION_STRING environment variable');
  process.exit(1);
}

if (!fs.existsSync(schemaFile)) {
  console.error(`❌ Schema file not found: ${schemaFile}`);
  process.exit(1);
}

// Parse connection string manually
// Format: postgresql://user:password-pooler.host/database?params
function parseConnectionString(connStr) {
  // Extract the base parts
  const match = connStr.match(/^postgresql:\/\/([^:]+):([^\/]+)\/(.+?)(?:\?|$)/);
  if (!match) {
    throw new Error('Could not parse connection string');
  }

  const [, user, passwordAndHost, dbAndParams] = match;
  const [db] = dbAndParams.split('?');

  // Extract password and host from password-pooler.host format
  // The password is before the first "-pooler" and host is everything after
  const poolerMatch = passwordAndHost.match(/^([^-]+)-(.+)$/);
  if (!poolerMatch) {
    throw new Error('Could not extract password and host from connection string');
  }

  const [, password, host] = poolerMatch;

  return {
    user: user,
    password: password,
    host: host,
    port: 5432,
    database: db,
    ssl: { rejectUnauthorized: false },
  };
}

async function runMigration() {
  let config;
  try {
    config = parseConnectionString(connString);
  } catch (err) {
    console.error('❌ Connection string parse error:', err.message);
    process.exit(1);
  }

  const client = new Client(config);

  try {
    console.log('Connecting to Neon...');
    await client.connect();
    console.log('✓ Connected\n');

    const schema = fs.readFileSync(schemaFile, 'utf8');

    console.log('Running schema migration...');
    await client.query(schema);
    console.log('✓ Schema created\n');

    // Verify tables were created
    console.log('Verifying tables...');
    const result = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);

    const tables = result.rows.map(r => r.table_name);
    const expectedTables = [
      'tenants', 'users', 'documents', 'document_pages',
      'facets', 'proposals', 'schema_versions', 'extractions',
      'entities', 'audit_log'
    ];

    const missing = expectedTables.filter(t => !tables.includes(t));
    const created = expectedTables.filter(t => tables.includes(t));

    console.log(`✓ Created ${created.length} tables:`);
    created.forEach(t => console.log(`  ├─ ${t}`));

    if (missing.length > 0) {
      console.error(`❌ Missing tables: ${missing.join(', ')}`);
      process.exit(1);
    }

    // Verify RLS is enabled
    console.log('\nVerifying Row-Level Security...');
    const rlsResult = await client.query(`
      SELECT schemaname, tablename, rowsecurity
      FROM pg_tables
      WHERE schemaname = 'public'
      AND tablename IN (${expectedTables.map((_, i) => `$${i+1}`).join(',')})
      ORDER BY tablename
    `, expectedTables);

    const rlsEnabled = rlsResult.rows.filter(r => r.rowsecurity).length;
    console.log(`✓ RLS enabled on ${rlsEnabled}/${expectedTables.length} tables`);

    console.log('\n✅ Migration complete. Postgres schema is ready for M3.');

  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    if (err.detail) console.error('Detail:', err.detail);
    process.exit(1);
  } finally {
    await client.end();
  }
}

runMigration();
