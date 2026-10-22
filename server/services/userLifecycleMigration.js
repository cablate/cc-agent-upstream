const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  ensurePrivateDirectory,
} = require('./privateFiles');
// The backup manifest's schema is stored data, named by the product (siteConfig.js).
const { PRODUCT } = require('../siteConfig');
const {
  LIFECYCLE_STATUS,
  LIFECYCLE_SCHEMA_VERSION,
  normalizeUsername,
  effectiveLifecycleStatus,
} = require('./userLifecycle');

function databaseCall(database, method, ...args) {
  return new Promise((resolve, reject) => {
    database[method](...args, (error, value) => (error ? reject(error) : resolve(value)));
  });
}

function findMany(database, query = {}) {
  return new Promise((resolve, reject) => {
    database.find(query).exec((error, values) => (error ? reject(error) : resolve(values)));
  });
}

function migrationError(message, details) {
  return Object.assign(new Error(message), {
    status: 409,
    code: 'USER_LIFECYCLE_MIGRATION_BLOCKED',
    details,
  });
}

function sha256File(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function regularFileInfo(filename) {
  const resolved = path.resolve(filename);
  const info = fs.lstatSync(resolved);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw migrationError('User datastore backup source is not a regular file', { filename: resolved });
  }
  return { resolved, info };
}

function validateUsersFileForRead(usersFilename) {
  const result = regularFileInfo(usersFilename);
  if ((result.info.mode & 0o077) !== 0) {
    throw migrationError('User datastore is not private enough to read', {
      mode: result.info.mode & 0o777,
    });
  }
  if (fs.existsSync(`${result.resolved}~`)) {
    throw migrationError('User datastore has an unresolved NeDB companion file');
  }
  return result;
}

function readUsersFileRecords(usersFilename) {
  const { resolved } = validateUsersFileForRead(usersFilename);
  const records = new Map();
  const lines = fs.readFileSync(resolved, 'utf8').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index]) continue;
    let document;
    try {
      document = JSON.parse(lines[index]);
    } catch (_error) {
      throw migrationError('User datastore contains malformed JSON', { line: index + 1 });
    }
    if (document && document._id !== undefined && document._id !== null) {
      const id = String(document._id);
      if (document.$$deleted === true) records.delete(id);
      else records.set(id, document);
      continue;
    }
    if (document?.$$indexCreated || typeof document?.$$indexRemoved === 'string') continue;
    throw migrationError('User datastore contains an unknown record', { line: index + 1 });
  }
  return [...records.values()];
}

function backupUsersFile(usersFilename, backupDirectory, { now = () => new Date() } = {}) {
  const { resolved: source, info } = validateUsersFileForRead(usersFilename);
  const directory = ensurePrivateDirectory(backupDirectory);
  const backup = path.join(directory, 'users.db');
  const manifestFile = path.join(directory, 'user-lifecycle-backup-manifest.json');
  if (fs.existsSync(backup) || fs.existsSync(manifestFile)) {
    throw migrationError('User lifecycle backup target is not empty', { backupDirectory: directory });
  }
  fs.copyFileSync(source, backup, fs.constants.COPYFILE_EXCL);
  const mode = info.mode & 0o777;
  fs.chmodSync(backup, mode);
  const manifest = {
    schema: PRODUCT.lifecycleBackupSchema,
    createdAt: now().toISOString(),
    sourceBasename: path.basename(source),
    backupBasename: path.basename(backup),
    size: fs.statSync(backup).size,
    mode,
    sha256: sha256File(backup),
  };
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf8', flag: 'wx', mode: PRIVATE_FILE_MODE,
  });
  fs.chmodSync(manifestFile, PRIVATE_FILE_MODE);
  return { backup, manifestFile, manifest };
}

function restoreUsersFile(backupDirectory, usersFilename) {
  const directory = path.resolve(backupDirectory);
  const directoryInfo = fs.lstatSync(directory);
  if (
    directoryInfo.isSymbolicLink()
    || !directoryInfo.isDirectory()
    || (directoryInfo.mode & 0o077) !== 0
  ) {
    throw migrationError('User lifecycle backup directory is not private');
  }
  const manifestFile = path.join(directory, 'user-lifecycle-backup-manifest.json');
  const backup = path.join(directory, 'users.db');
  const { info } = regularFileInfo(backup);
  regularFileInfo(manifestFile);
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch (_error) {
    throw migrationError('User lifecycle backup manifest is invalid');
  }
  if (
    manifest?.schema !== PRODUCT.lifecycleBackupSchema
    || manifest.sourceBasename !== path.basename(usersFilename)
    || manifest.backupBasename !== 'users.db'
    || manifest.size !== info.size
    || manifest.sha256 !== sha256File(backup)
    || manifest.mode !== (info.mode & 0o777)
    || (manifest.mode & 0o077) !== 0
  ) {
    throw migrationError('User lifecycle backup verification failed');
  }
  const target = path.resolve(usersFilename);
  ensurePrivateDirectory(path.dirname(target));
  if (fs.existsSync(target)) regularFileInfo(target);
  if (fs.existsSync(`${target}~`)) {
    throw migrationError('Restore target has an unresolved NeDB companion file');
  }
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.restore-${process.pid}-${Date.now()}`,
  );
  try {
    fs.copyFileSync(backup, temporary, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(temporary, manifest.mode);
    const descriptor = fs.openSync(temporary, 'r');
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, target);
    const directoryDescriptor = fs.openSync(path.dirname(target), 'r');
    try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch (_cleanupError) { /* absent */ }
    throw error;
  }
  const result = {
    restored: target,
    size: fs.statSync(target).size,
    mode: fs.statSync(target).mode & 0o777,
    sha256: sha256File(target),
  };
  if (
    result.size !== manifest.size
    || result.mode !== manifest.mode
    || result.sha256 !== manifest.sha256
  ) {
    throw migrationError('Restored user datastore verification failed');
  }
  return result;
}

function inventoryUserLifecycleRecords(users) {
  const counts = {
    active: 0,
    disabled: 0,
    deletedTombstone: 0,
    legacyMissingLifecycle: 0,
  };
  const plan = [];
  const errors = [];
  const names = new Map();

  for (const user of users) {
    let status;
    let normalized;
    try {
      status = effectiveLifecycleStatus(user);
      normalized = normalizeUsername(user.username);
    } catch (error) {
      errors.push({ userId: String(user?._id || ''), code: error.code || 'USER_LIFECYCLE_INVALID' });
      continue;
    }
    if (user.lifecycleStatus === undefined || user.lifecycleStatus === null) {
      counts.legacyMissingLifecycle += 1;
    }
    if (status === LIFECYCLE_STATUS.ACTIVE) counts.active += 1;
    if (status === LIFECYCLE_STATUS.DISABLED) counts.disabled += 1;
    if (status === LIFECYCLE_STATUS.DELETED_TOMBSTONE) counts.deletedTombstone += 1;

    const duplicate = names.get(normalized);
    if (duplicate && duplicate !== String(user._id)) {
      errors.push({
        userId: String(user._id), code: 'DUPLICATE_NORMALIZED_USERNAME', conflictingUserId: duplicate,
      });
    } else {
      names.set(normalized, String(user._id));
    }

    const fields = [];
    if (user.lifecycleStatus !== status) fields.push('lifecycleStatus');
    if (user.lifecycleSchemaVersion !== LIFECYCLE_SCHEMA_VERSION) fields.push('lifecycleSchemaVersion');
    if (user.normalizedUsername !== normalized) fields.push('normalizedUsername');
    if (fields.length) plan.push({ userId: String(user._id), status, normalizedUsername: normalized, fields });
  }

  return {
    total: users.length,
    ...counts,
    invalid: errors.length,
    errors,
    plannedChanges: plan.length,
    plan,
  };
}

async function inventoryUserLifecycle(usersDB) {
  return inventoryUserLifecycleRecords(await findMany(usersDB));
}

function inventoryUserLifecycleFile(usersFilename) {
  return inventoryUserLifecycleRecords(readUsersFileRecords(usersFilename));
}

async function migrateUserLifecycle(usersDB, { apply = false, now = () => new Date() } = {}) {
  const before = await inventoryUserLifecycle(usersDB);
  if (before.errors.length) {
    throw migrationError('User lifecycle migration inventory is not safe to apply', before.errors);
  }
  if (!apply) {
    return { mode: 'dry-run', changed: 0, wouldChange: before.plannedChanges, before };
  }
  const migratedAt = now().toISOString();
  let changed = 0;
  for (const item of before.plan) {
    const count = await databaseCall(
      usersDB, 'update', { _id: item.userId },
      { $set: {
        lifecycleStatus: item.status,
        lifecycleSchemaVersion: LIFECYCLE_SCHEMA_VERSION,
        normalizedUsername: item.normalizedUsername,
        lifecycleMigratedAt: migratedAt,
      } }, {},
    );
    changed += Number(count || 0);
  }
  require('./compactQuietly').compactQuietly(usersDB, 'users');
  const after = await inventoryUserLifecycle(usersDB);
  if (after.errors.length || after.plannedChanges) {
    throw migrationError('User lifecycle migration did not converge', after);
  }
  return { mode: 'apply', changed, wouldChange: before.plannedChanges, before, after };
}

module.exports = {
  inventoryUserLifecycle,
  inventoryUserLifecycleFile,
  migrateUserLifecycle,
  backupUsersFile,
  restoreUsersFile,
  validateUsersFileForRead,
  sha256File,
  PRIVATE_DIR_MODE,
};
