#!/usr/bin/env node

const path = require('node:path');
const Datastore = require('@seald-io/nedb');
const { privateDatastoreOptions } = require('../services/privateFiles');
const {
  inventoryUserLifecycleFile,
  migrateUserLifecycle,
  backupUsersFile,
  restoreUsersFile,
} = require('../services/userLifecycleMigration');

function parseArgs(argv) {
  const options = { mode: null, dbDir: null, backupDir: null, ackQuiesced: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--dry-run') options.mode = options.mode ? 'invalid' : 'dry-run';
    else if (value === '--apply') options.mode = options.mode ? 'invalid' : 'apply';
    else if (value === '--restore') options.mode = options.mode ? 'invalid' : 'restore';
    else if (value === '--ack-quiesced') options.ackQuiesced = true;
    else if (value === '--db-dir') options.dbDir = argv[index += 1];
    else if (value === '--backup-dir') options.backupDir = argv[index += 1];
    else throw new Error(`unknown argument: ${value}`);
  }
  if (!['dry-run', 'apply', 'restore'].includes(options.mode)) {
    throw new Error('choose exactly one of --dry-run, --apply, or --restore');
  }
  if (!options.dbDir) throw new Error('--db-dir is required');
  if (['apply', 'restore'].includes(options.mode) && (!options.ackQuiesced || !options.backupDir)) {
    throw new Error(`${options.mode} requires --backup-dir and --ack-quiesced`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const usersFilename = path.resolve(options.dbDir, 'users.db');
  if (options.mode === 'restore') {
    return { mode: 'restore', ...restoreUsersFile(options.backupDir, usersFilename) };
  }
  if (options.mode === 'dry-run') {
    return { mode: 'dry-run', inventory: inventoryUserLifecycleFile(usersFilename) };
  }
  let backup = null;
  if (options.mode === 'apply') {
    backup = backupUsersFile(usersFilename, options.backupDir);
  }
  const usersDB = new Datastore(privateDatastoreOptions(usersFilename));
  const migration = await migrateUserLifecycle(usersDB, { apply: true });
  return {
    mode: 'apply',
    backup: {
      file: backup.backup,
      manifest: backup.manifestFile,
      sha256: backup.manifest.sha256,
      size: backup.manifest.size,
      mode: backup.manifest.mode,
    },
    migration,
  };
}

if (require.main === module) {
  main()
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${JSON.stringify({
        error: error.message,
        code: error.code || 'USER_LIFECYCLE_MIGRATION_FAILED',
        details: error.details,
      })}\n`);
      process.exitCode = 1;
    });
}

module.exports = { parseArgs, main };
