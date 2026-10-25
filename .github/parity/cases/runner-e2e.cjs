'use strict';
// Black box for channel/runner.mjs: each tree's runner is started with a fake claude and a fake tmux on PATH
// and a default runtime config, and what it hands to claude (argv, env, cwd), to tmux and to the server, and
// the files it writes, are compared. Needs POSIX shell scripts as the fake programs, so Windows skips it.
// Each run takes about a second, three of the modes wait for the startup prompt loop (about 3 s).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const MODES = {
  full: 'default full-access agent, config as the server writes it',
  'full-bare': 'the same with an older config that has no bound or globalHarness key',
  scoped: 'scoped agent (refused off macOS: its temp fence needs /tmp to be /private/tmp, so the refusal is what is compared)',
  resume: 'config.resume',
  'no-home': 'HOME missing from the environment (fails before claude starts)',
  'empty-home': 'HOME set to an empty string, which reads as "no home" without failing',
  'prompt-workspace': 'trust-this-folder screen, then Enter',
  'prompt-workspace-no': 'trust-this-folder screen with No selected, then Down and Enter',
  'prompt-channel': 'development channel warning, then Enter',
};
// Modes in which the runner is expected to stop before it starts claude. A mode that should start but does not
// fails its cases (see the end of this file).
const NO_START = new Set(['no-home', 'scoped']);
const FACETS = ['launch', 'env', 'tmux', 'files'];
const TMP_ROOT = process.env.PARITY_TMP || os.tmpdir();
const memo = new Map();

function walk(dir, prefix, out) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name), rel = `${prefix}/${name}`, st = fs.lstatSync(full), mode = (st.mode & 0o777).toString(8);
    if (st.isSymbolicLink()) out[rel] = { type: 'link', to: fs.readlinkSync(full) };
    else if (st.isDirectory()) { out[rel] = { type: 'dir', mode }; walk(full, rel, out); }
    else { const data = fs.readFileSync(full); out[rel] = { type: 'file', mode, ...(data.length < 4000 || process.env.PARITY_FULL_FILES ? { text: data.toString('utf8') } : { sha: crypto.createHash('sha1').update(data).digest('hex').slice(0, 10) }) }; }
  }
  return out;
}

const scrub = (v, subs) => (typeof v === 'string' ? subs.reduce((s, [from, to]) => s.split(from).join(to), v)
  : Array.isArray(v) ? v.map((x) => scrub(x, subs)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [scrub(k, subs), scrub(x, subs)])) : v); // keys too: file paths are keys

async function observe(root, mode) {
  const base = fs.mkdtempSync(path.join(TMP_ROOT, 'parity-e2e-'));
  const cid = `${crypto.randomBytes(4).toString('hex')}-aaaa-bbbb`, tmpName = `${cid.slice(0, 8)}-g1`;
  const agentRoot = `/tmp/cca-${process.getuid()}`, agentRootExisted = fs.existsSync(agentRoot);
  const calls = [];
  const bridge = http.createServer((req, res) => { let body = ''; req.on('data', (d) => { body += d; }); req.on('end', () => { calls.push(`${req.url.split('/').pop()} ${body.slice(0, 300)}`); res.setHeader('content-type', 'application/json'); res.end('{}'); }); });
  try {
    await new Promise((resolve) => bridge.listen(0, '127.0.0.1', resolve));
    const [home, work, control, bin, rec] = ['home', 'ws', 'ws-control', 'bin', 'rec'].map((d) => path.join(base, d));
    for (const d of [home, work, control, bin, rec, path.join(work, 'cwd'), path.join(work, 'ref'), path.join(work, 'att')]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: {}, claudeAiMcpEverConnected: [] }));
    const prompt = mode.startsWith('prompt');
    const cwd = path.join(work, 'cwd');
    fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(path.join(rec, 'claude.json'))},JSON.stringify({argv:process.argv.slice(2),env:process.env,cwd:process.cwd()}));\n${prompt ? 'setTimeout(()=>{},2600);' : ''}\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(rec, 'screen.txt'), mode === 'prompt-channel' ? 'Channels: server:executive\nWARNING: Loading development channels\n❯ 1. I am using this for local development\n'
      : mode === 'prompt-workspace-no' ? `Accessing workspace:\n\n${cwd}\n\nYes, I trust this folder\n❯ No, exit\n`
        : `Accessing workspace:\n\n${cwd}\n\n❯ Yes, I trust this folder\n`);
    fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh\necho "$@" >> ${path.join(rec, 'tmux.log')}\ncase "$*" in *capture-pane*) cat ${path.join(rec, 'screen.txt')};; esac\n`, { mode: 0o755 });
    const access = mode === 'scoped' ? { full: false, allow: [], exclude: [], domains: [], mcp: [] } : { full: true };
    const config = {
      tmuxSocket: 'cc-agent-0123456789abcdef', reference: path.join(work, 'ref'), attachments: path.join(work, 'att'),
      conversationId: cid, sessionId: '11111111-2222-3333-4444-555555555555', token: 'tok', generation: 1,
      server: `http://127.0.0.1:${bridge.address().port}`, root, cwd, memory: '', profile: { title: 'T', description: '', memory: '', model: 'claude-sonnet-5-5', effort: 'high', access },
      model: 'claude-sonnet-5-5', effort: 'high', handoff: null, access, resume: mode === 'resume',
      // What the server writes by default; an older runtime would not have them. Either tree ignores a key it does not know.
      ...(mode === 'full-bare' ? {} : { bound: false, globalHarness: true }),
    };
    fs.writeFileSync(path.join(control, 'runtime.json'), JSON.stringify(config));
    const env = { PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`, HOME: home, TMUX_PANE: '%7', TMUX: 'x', LANG: 'C.UTF-8', USER: 'fixture', TERM: 'xterm', JWT_SECRET: 'leak', TMPDIR: '/tmp' };
    if (mode === 'no-home') delete env.HOME;
    if (mode === 'empty-home') env.HOME = '';
    // Its own working folder: an empty HOME makes ~/.claude a relative path, which must land here.
    const proc = path.join(base, 'proc'); fs.mkdirSync(proc);
    // The transcript it looks for under that relative ~/.claude is there, so a runner that reads the empty HOME
    // as some other home starts a new session where this one resumes (--resume instead of --session-id).
    if (mode === 'empty-home') {
      const transcript = path.join(proc, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${config.sessionId}.jsonl`);
      fs.mkdirSync(path.dirname(transcript), { recursive: true }); fs.writeFileSync(transcript, '{}\n');
    }
    const ran = await new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(root, 'channel/runner.mjs'), path.join(control, 'runtime.json')], { env, cwd: proc });
      let stderr = ''; child.stderr.on('data', (d) => { stderr += d; });
      const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
      child.on('exit', (status) => { clearTimeout(timer); setTimeout(() => resolve({ status, stderr }), 200); });
    });
    const read = (...parts) => { try { return fs.readFileSync(path.join(rec, ...parts), 'utf8'); } catch { return null; } };
    const claude = read('claude.json') && JSON.parse(read('claude.json'));
    const tmuxLog = read('tmux.log');
    // The fake tmux sees one capture per tick; the number of ticks is timing, so repeats are folded.
    const tmux = tmuxLog && tmuxLog.trim().split('\n').filter((line, i, all) => line !== all[i - 1]);
    const tmpNames = (dir, label) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.includes(tmpName.slice(0, 8))).sort().map((n) => ({ n, label })) : []);
    const tmpAgent = [...tmpNames('/tmp', '/tmp'), ...tmpNames(agentRoot, agentRoot)];
    const filesTree = walk(control, 'control', {}); delete filesTree['control/runtime.json'];
    const files = walk(proc, 'proc', walk(home, 'home', walk(cwd, 'cwd', filesTree)));
    // The folder name also appears the way Claude spells a cwd for its project folders: every other character a '-'.
    const subs = [[fs.realpathSync(base), '<base>'], [base, '<base>'], [base.replace(/[^a-zA-Z0-9]/g, '-'), '<base-as-cwd-name>'], [root, '<root>'], [cid, '<cid>'], [cid.slice(0, 8), '<cid8>']];
    const result = scrub({
      started: Boolean(claude), setupFailed: !NO_START.has(mode) && !claude ? `claude did not start: ${ran.stderr.slice(0, 200)}` : undefined,
      launch: { status: ran.status, stderr: ran.stderr.split('\n').filter((l) => /Error/.test(l) && !/^\s+at |ExperimentalWarning/.test(l)).slice(0, 2).join('\n').slice(0, 400), claudeArgv: claude && claude.argv, claudeCwd: claude && claude.cwd, bridge: calls.slice() },
      env: { keys: claude && Object.keys(claude.env).sort(), selected: claude && Object.fromEntries(Object.entries(claude.env).filter(([k]) => /^(HOME|TMPDIR|CLAUDE_|GIT_|TMPPREFIX|TEMP|TMP|LANG|PATH|DISCORD|ENABLE)/.test(k))) },
      tmux: { log: tmux, tmpAgent },
      files,
    }, subs);
    for (const t of tmpAgent) fs.rmSync(path.join(t.label, t.n), { recursive: true, force: true });
    // The shared folder of scoped agents is only ours to remove when this run made it.
    if (!agentRootExisted) fs.rmSync(agentRoot, { recursive: true, force: true });
    return result;
  } finally {
    bridge.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
}

module.exports = (root) => {
  if (process.platform === 'win32') return { 'e2e: the fake claude and tmux are POSIX scripts': () => ({ setupFailed: 'win32' }) };
  const cases = {};
  for (const mode of Object.keys(MODES)) for (const facet of FACETS) {
    cases[`e2e ${mode}: ${facet}`] = async () => {
      const key = `${root}\0${mode}`;
      if (!memo.has(key)) memo.set(key, observe(root, mode));
      const seen = await memo.get(key);
      // A mode that should start but did not is a failure, never a skip: the message names the tree, so the two
      // sides cannot agree on it, and a runner broken in both trees cannot pass as "same".
      if (seen.setupFailed) throw new Error(`${root}: ${seen.setupFailed}`);
      return { started: seen.started, [facet]: seen[facet] };
    };
  }
  return cases;
};
