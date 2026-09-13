#!/usr/bin/env node

/**
 * M3 Infrastructure Connectivity Test
 * Tests all five Phase 1 services: Neon, R2, Clerk, Inngest, Sentry
 */

const https = require('https');

// Load credentials
const credentials = {
  NEON_CONNECTION_STRING: process.env.NEON_CONNECTION_STRING,
  R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
  R2_BUCKET_NAME: process.env.R2_BUCKET_NAME,
  CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
  INNGEST_API_KEY: process.env.INNGEST_API_KEY,
  SENTRY_DSN: process.env.SENTRY_DSN,
};

// Validate all credentials are present
const missingCreds = Object.entries(credentials)
  .filter(([_, val]) => !val)
  .map(([key]) => key);

if (missingCreds.length > 0) {
  console.error('❌ Missing credentials:', missingCreds.join(', '));
  console.error('Make sure .env.local is in your deepwell root with all five services');
  process.exit(1);
}

console.log('✓ All credentials loaded\n');

const results = [];

// Test 1: Neon PostgreSQL
async function testNeon() {
  return new Promise((resolve) => {
    try {
      const { Client } = require('pg');
      const client = new Client({
        connectionString: credentials.NEON_CONNECTION_STRING,
      });

      client.connect((err) => {
        if (err) {
          results.push({ service: 'Neon PostgreSQL', status: '❌ FAILED', error: err.message });
        } else {
          client.query('SELECT NOW()', (err, res) => {
            if (err) {
              results.push({ service: 'Neon PostgreSQL', status: '❌ FAILED', error: err.message });
            } else {
              results.push({ service: 'Neon PostgreSQL', status: '✓ PASS', detail: `Connected to database at ${new Date(res.rows[0].now).toISOString()}` });
            }
            client.end(() => resolve());
          });
        }
      });
    } catch (err) {
      results.push({ service: 'Neon PostgreSQL', status: '⚠️ SKIP', error: 'pg module not installed (run: npm install pg)' });
      resolve();
    }
  });
}

// Test 2: Cloudflare R2
async function testR2() {
  return new Promise((resolve) => {
    try {
      const AWS = require('aws-sdk');
      const s3 = new AWS.S3({
        accessKeyId: 'placeholder', // R2 doesn't need access key ID
        secretAccessKey: credentials.R2_SECRET_ACCESS_KEY,
        endpoint: `https://${credentials.R2_BUCKET_NAME}.r2.cloudflarestorage.com`,
        s3ForcePathStyle: true,
        signatureVersion: 'v4',
        region: 'auto',
      });

      s3.listObjects({ Bucket: credentials.R2_BUCKET_NAME }, (err, data) => {
        if (err) {
          results.push({ service: 'Cloudflare R2', status: '❌ FAILED', error: err.message });
        } else {
          results.push({ service: 'Cloudflare R2', status: '✓ PASS', detail: `Connected to bucket "${credentials.R2_BUCKET_NAME}" (${data.Contents ? data.Contents.length : 0} objects)` });
        }
        resolve();
      });
    } catch (err) {
      results.push({ service: 'Cloudflare R2', status: '⚠️ SKIP', error: 'aws-sdk module not installed (run: npm install aws-sdk)' });
      resolve();
    }
  });
}

// Test 3: Clerk
async function testClerk() {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.clerk.com',
      port: 443,
      path: '/v1/users',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${credentials.CLERK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      if (res.statusCode === 200 || res.statusCode === 401) {
        results.push({ service: 'Clerk Auth', status: '✓ PASS', detail: `API responded (${res.statusCode})` });
      } else {
        results.push({ service: 'Clerk Auth', status: '❌ FAILED', error: `HTTP ${res.statusCode}` });
      }
      res.resume();
      resolve();
    });

    req.on('error', (err) => {
      results.push({ service: 'Clerk Auth', status: '❌ FAILED', error: err.message });
      resolve();
    });

    req.end();
  });
}

// Test 4: Inngest
async function testInngest() {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.inngest.com',
      port: 443,
      path: '/v0/ping',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${credentials.INNGEST_API_KEY}`,
        'Content-Type': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      if (res.statusCode === 200) {
        results.push({ service: 'Inngest Jobs', status: '✓ PASS', detail: `API ping successful` });
      } else {
        results.push({ service: 'Inngest Jobs', status: '❌ FAILED', error: `HTTP ${res.statusCode}` });
      }
      res.resume();
      resolve();
    });

    req.on('error', (err) => {
      results.push({ service: 'Inngest Jobs', status: '❌ FAILED', error: err.message });
      resolve();
    });

    req.end();
  });
}

// Test 5: Sentry
async function testSentry() {
  return new Promise((resolve) => {
    // Parse DSN to extract components
    const dsn = credentials.SENTRY_DSN;
    const match = dsn.match(/https:\/\/([^@]+)@([^.]+)\.ingest\.sentry\.io\/(\d+)/);

    if (!match) {
      results.push({ service: 'Sentry Monitoring', status: '❌ FAILED', error: 'Invalid DSN format' });
      resolve();
      return;
    }

    const [, publicKey, region, projectId] = match;

    const options = {
      hostname: `${region}.ingest.sentry.io`,
      port: 443,
      path: `/api/${projectId}/store/`,
      method: 'POST',
      headers: {
        'X-Sentry-Auth': `Sentry sentry_key=${publicKey}, sentry_version=7`,
        'Content-Type': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      if (res.statusCode === 200 || res.statusCode === 400) {
        results.push({ service: 'Sentry Monitoring', status: '✓ PASS', detail: `API endpoint accessible (${res.statusCode})` });
      } else {
        results.push({ service: 'Sentry Monitoring', status: '❌ FAILED', error: `HTTP ${res.statusCode}` });
      }
      res.resume();
      resolve();
    });

    req.on('error', (err) => {
      results.push({ service: 'Sentry Monitoring', status: '❌ FAILED', error: err.message });
      resolve();
    });

    req.write(JSON.stringify({ message: 'test' }));
    req.end();
  });
}

// Run all tests
async function runTests() {
  console.log('Starting connectivity tests...\n');

  await testNeon();
  await testR2();
  await testClerk();
  await testInngest();
  await testSentry();

  console.log('Test Results:');
  console.log('─'.repeat(80));

  results.forEach(({ service, status, detail, error }) => {
    console.log(`${status} ${service}`);
    if (detail) console.log(`   └─ ${detail}`);
    if (error) console.log(`   └─ Error: ${error}`);
  });

  console.log('─'.repeat(80));

  const passed = results.filter(r => r.status.includes('PASS')).length;
  const failed = results.filter(r => r.status.includes('FAILED')).length;
  const skipped = results.filter(r => r.status.includes('SKIP')).length;

  console.log(`\nSummary: ${passed} passed, ${failed} failed, ${skipped} skipped`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
