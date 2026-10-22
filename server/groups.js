// Group chats: several of the owner's agents in
// one room. The owner's message goes to the agents it names with @, or to the
// group's lead; their answers, and what members send one another across sessions,
// show in the room. The rules live in agentStore.js; this keeps the records.
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');

const MAX_NAME = 40, MAX_MEMBERS = 12, MAX_GROUPS = 50, KEEP_MESSAGES = 1000;

function create(stateRoot) {
  const file = path.join(stateRoot, 'groups.json');
  let groups = null;
  // A missing file is no groups; an unreadable one is set aside, never written over.
  const load = () => {
    if (groups) return groups;
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; groups = []; return groups; }
    try { groups = JSON.parse(raw).groups || []; } catch {
      const aside = `${file}.unreadable-${Date.now()}`;
      fs.renameSync(file, aside);
      console.error(`groups: ${file} could not be read and was moved to ${aside}`);
      groups = [];
    }
    return groups;
  };
  let written = '';
  const save = () => {
    const text = JSON.stringify({groups: load()}, null, 1);
    if (text === written) return;
    fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
    const tmp = `${file}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    written = text;
  };
  const list = () => load().slice();
  const get = (id) => load().find((x) => x.id === id) || null;
  function add(owner, {name, members, lead}) {
    if (load().filter((x) => x.owner === owner).length >= MAX_GROUPS) throw Object.assign(new Error('群組最多 ' + MAX_GROUPS + ' 個'), {status: 400});
    const now = new Date().toISOString();
    const x = {id: randomUUID(), owner, name, members, lead, messages: [], checklists: [], createdAt: now, updatedAt: now};
    load().push(x); save();
    return x;
  }
  function remove(id) { groups = load().filter((x) => x.id !== id); save(); }
  function addMessage(x, fields) {
    const m = {id: randomUUID(), at: new Date().toISOString(), ...fields};
    x.messages.push(m);
    if (x.messages.length > KEEP_MESSAGES) x.messages.splice(0, x.messages.length - KEEP_MESSAGES);
    x.updatedAt = m.at;
    return m;
  }
  // An account's groups go with it.
  function purgeOwner(owner) { groups = load().filter((x) => x.owner !== owner); save(); }
  return {list, get, add, remove, save, addMessage, purgeOwner};
}

// A name, members and lead as the owner gives them; which agents may be members is
// the caller's to check.
function shape({name, members, lead} = {}) {
  const fail = (message) => Object.assign(new Error(message), {status: 400});
  if (typeof name !== 'string' || !name.trim() || name.trim().length > MAX_NAME) throw fail('群組名稱需為 1–' + MAX_NAME + ' 字');
  if (!Array.isArray(members) || !members.length || members.some((id) => typeof id !== 'string')) throw fail('至少要有一位成員');
  const unique = [...new Set(members)];
  if (unique.length > MAX_MEMBERS) throw fail('成員最多 ' + MAX_MEMBERS + ' 位');
  if (!unique.includes(lead)) throw fail('主負責要是成員之一');
  return {name: name.trim(), members: unique, lead};
}

module.exports = {create, shape, MAX_MEMBERS, KEEP_MESSAGES};
