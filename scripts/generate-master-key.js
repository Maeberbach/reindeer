#!/usr/bin/env node

/**
 * Generate a random master encryption key for Reindeer estate databases.
 *
 * Run this ONCE during initial server setup. Store the output in the
 * REINDEER_MASTER_KEY environment variable on the server.
 *
 * NEVER commit this key to version control.
 * NEVER store it in the database.
 * If lost, all encrypted estate databases become unrecoverable.
 *
 * Usage:
 *   node scripts/generate-master-key.js
 *
 * Then set in your environment (Render, .env, etc.):
 *   REINDEER_MASTER_KEY=<the output>
 */

import crypto from 'node:crypto';

const key = crypto.randomBytes(32).toString('hex');

console.log('========================================================');
console.log(' Reindeer Master Encryption Key');
console.log('========================================================');
console.log();
console.log(' Add this to your server environment:');
console.log();
console.log(`  REINDEER_MASTER_KEY=${key}`);
console.log();
console.log(' ⚠️  SAVE THIS KEY. If you lose it, all encrypted estate');
console.log('     databases become permanently unrecoverable.');
console.log();
console.log(' ⚠️  NEVER commit this to git, never store it in the DB,');
console.log('     never share it outside your server infrastructure.');
console.log();
console.log('========================================================');
