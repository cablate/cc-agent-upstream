'use strict';
// A case exports (root) => ({ name: () => value, ... }); values may be promises.
// Optional `expected` (B units) and `featureDifferences` (F units) map a case name to { unit, reason }.
//
// What a case returns or throws is kept as an exact observation: undefined, null, NaN, -0,
// Infinity, missing keys and error name/message/code all stay distinguishable (see `encode`).
//
// The host decides the policy, a case file cannot:
//   strict    win32 (or PARITY_STRICT=1). The two trees must be identical; B and F declarations are
//             not accepted, so a leaked or accidental change cannot hide behind a reason string.
//   declared  everywhere else. Undeclared differences fail. A B difference must equal the
//             observations pinned in <cases>/expected-b.json on BOTH sides, so a drift, a new
//             thrown error or a syntax error fails. An F difference may change a value, but a
//             thrown error fails. A declaration whose case no longer differs is stale and fails.
// PARITY_CAPTURE=<file> writes the pins from the current run (declared policy, full run only);
// review the file before it is placed in the cases folder.
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');

const only = process.argv.slice(2);
const caseRoot = process.env.PARITY_CASES || path.join(__dirname, 'cases');
const upRoot = process.env.PARITY_UP_ROOT || '/up';
const oursRoot = process.env.PARITY_OURS_ROOT || '/ours';
const strict = process.platform === 'win32' || process.env.PARITY_STRICT === '1';
const capturePath = process.env.PARITY_CAPTURE || '';
const FIXTURE = 'expected-b.json';

// ---- observations: JSON-safe, nothing collapses into null or a missing key
const TAG = '$parity';
const tag = (kind, rest) => ({ [TAG]: kind, ...rest });
const { types } = util;
function errorInfo(e) {
  return { name: String(e.name), message: String(e.message), ...(e.code !== undefined ? { code: encode(e.code) } : {}) };
}
function encode(v, parents = []) {
  switch (typeof v) {
    case 'undefined': return tag('undefined');
    case 'boolean': case 'string': return v;
    case 'number': return Object.is(v, -0) ? tag('-0') : Number.isFinite(v) ? v : tag(String(v));
    case 'bigint': return tag('bigint', { value: String(v) });
    case 'symbol': return tag('symbol', { description: String(v.description) });
    case 'function': return tag('function', { name: v.name });
  }
  if (v === null) return null;
  if (parents.includes(v)) return tag('circular');
  const trail = [...parents, v];
  if (types.isNativeError(v) || v instanceof Error) return tag('error', errorInfo(v));
  if (types.isDate(v)) return tag('date', { value: Number.isNaN(v.getTime()) ? 'Invalid Date' : v.toISOString() });
  if (types.isRegExp(v)) return tag('regexp', { value: String(v) });
  if (types.isMap(v)) return tag('map', { entries: [...v].map(([k, x]) => [encode(k, trail), encode(x, trail)]) });
  if (types.isSet(v)) return tag('set', { values: [...v].map((x) => encode(x, trail)) });
  if (types.isArrayBuffer(v) || types.isDataView(v) || types.isTypedArray(v)) {
    const bytes = types.isArrayBuffer(v) ? new Uint8Array(v) : types.isDataView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : v;
    return tag('bytes', { type: Object.prototype.toString.call(v).slice(8, -1), data: Array.from(bytes, (x) => encode(x, trail)) });
  }
  if (Array.isArray(v)) return Array.from({ length: v.length }, (_, i) => (i in v ? encode(v[i], trail) : tag('hole')));
  if (typeof v.toJSON === 'function') return encode(v.toJSON(), trail);
  const plain = Object.fromEntries(Object.keys(v).map((k) => [k, encode(v[k], trail)]));
  return Object.hasOwn(v, TAG) ? tag('object', { value: plain }) : plain;
}
// A SyntaxError or ReferenceError anywhere in an observation means broken code or a broken
// harness, not a behavior difference: no B pin may contain one (a deliberately caught
// TypeError, as in W2-socketAgentId-missing-getuid, is ordinary behavior and stays comparable).
const CODE_ERRORS = new Set(['SyntaxError', 'ReferenceError']);
const taggedCodeError = (o) => {
  if (o === null || typeof o !== 'object') return false;
  if (o[TAG] === 'error' && CODE_ERRORS.has(o.name)) return true;
  return Object.values(o).some(taggedCodeError);
};
const brokenCode = (r) => (r.error ? CODE_ERRORS.has(r.error.name) || taggedCodeError(r.error) : taggedCodeError(r.value));
const thrown = (e) => (types.isNativeError(e) || e instanceof Error ? errorInfo(e) : { thrown: encode(e) });
const run = async (fn) => {
  let v;
  try { v = await fn(); } catch (e) { return { error: thrown(e) }; }
  return { value: encode(v) };
};

// ---- pinned B observations
let fixture;
const pinsFor = (file) => {
  if (fixture === undefined) {
    const target = path.join(caseRoot, FIXTURE);
    fixture = null;
    if (fs.existsSync(target)) {
      const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
      if (parsed.version !== 1 || !parsed.files || typeof parsed.files !== 'object') throw new Error(`Invalid pinned B fixture: ${target}`);
      fixture = parsed.files;
    }
  }
  return fixture && Object.hasOwn(fixture, file) ? fixture[file] : null;
};
// Carried into the fixture because JSON has no comments.
const NOTES = [
  'Pins are the reviewed intended outcomes of each B case, captured on Linux (node:22-bookworm-slim) for upstream (up) and the candidate tree (ours); a run fails when either side differs.',
  'The B4 kill-refusal pins use an injected kill that fails with EPERM. They show the code path, not a native macOS run: macOS EPERM behavior has not been verified natively.',
];
const serialize = (files) => {
  const out = ['{', ' "version": 1,', ` "generated": ${JSON.stringify({ platform: process.platform, node: process.version })},`, ` "notes": ${JSON.stringify(NOTES)},`, ' "files": {'];
  const fileNames = Object.keys(files);
  fileNames.forEach((f, fi) => {
    out.push(`  ${JSON.stringify(f)}: {`);
    const names = Object.keys(files[f]);
    names.forEach((n, ni) => {
      const p = files[f][n];
      out.push(`   ${JSON.stringify(n)}: {`, `    "unit": ${JSON.stringify(p.unit)},`, `    "up": ${JSON.stringify(p.up)},`, `    "ours": ${JSON.stringify(p.ours)}`, `   }${ni < names.length - 1 ? ',' : ''}`);
    });
    out.push(`  }${fi < fileNames.length - 1 ? ',' : ''}`);
  });
  out.push(' }', '}', '');
  return out.join('\n');
};

(async () => {
  for (const root of [upRoot, oursRoot]) if (!fs.statSync(root).isDirectory()) throw new Error(`Not a tree: ${root}`);
  if (capturePath && (strict || only.length || process.env.PARITY_NAME)) throw new Error('PARITY_CAPTURE needs the declared policy (not Windows, no PARITY_STRICT) and a run without file or name filters');
  const files = fs.readdirSync(caseRoot).filter((f) => f.endsWith('.cjs') && (!only.length || only.some((o) => f.startsWith(o)))).sort();
  if (!files.length) throw new Error('No case files selected');
  console.log(strict ? 'policy strict: any difference between the trees fails; B and F declarations are not accepted' : `policy declared: B differences must equal the pins in ${FIXTURE} on both sides; F differences may not throw; stale declarations fail`);
  let same = 0, expected = 0, features = 0, differ = 0, errors = 0, skipped = 0;
  const captured = {};
  const show = (label, file, name, a, b, note = '') => console.log(`${label} ${file} ${name}${note}\n  upstream: ${JSON.stringify(a)}\n  ours:     ${JSON.stringify(b)}`);
  for (const file of files) {
    try {
      const load = require(path.join(caseRoot, file));
      const up = await load(upRoot), ours = await load(oursRoot);
      const names = [...new Set([...Object.keys(up), ...Object.keys(ours)])];
      if (!names.length) throw new Error('No cases exported');
      const B = load.expected || {}, F = load.featureDifferences || {};
      for (const [kind, map, unit] of [['B', B, /^B[1-6]$/], ['F', F, /^F\d+$/]]) for (const [name, meta] of Object.entries(map)) {
        if (!names.includes(name) || !meta.unit || !meta.reason || !unit.test(meta.unit)) throw new Error(`Invalid ${kind} difference declaration: ${name}`);
      }
      for (const name of Object.keys(B)) if (Object.hasOwn(F, name)) throw new Error(`Declared as both B and F: ${name}`);
      let pins = {};
      if (!strict && !capturePath) {
        const found = pinsFor(file);
        if (Object.keys(B).length && !found) throw new Error(`Missing pinned B observations for ${file} in ${path.join(caseRoot, FIXTURE)}`);
        pins = found || {};
        for (const name of Object.keys(pins)) if (!Object.hasOwn(B, name)) throw new Error(`Pinned B observation without a B declaration: ${name}`);
      }
      for (const name of names) {
        if (process.env.PARITY_NAME && !name.startsWith(process.env.PARITY_NAME)) continue;
        if (typeof up[name] !== 'function' || typeof ours[name] !== 'function') { differ++; console.log(`DIFF ${file} ${name}: missing case function`); continue; }
        const a = await run(up[name]), b = await run(ours[name]);
        if (a.value?.setupFailed || b.value?.setupFailed) {
          if (!util.isDeepStrictEqual(a, b)) { errors++; console.log(`ERROR ${file} ${name}: fixture setup differs between trees`); }
          else { skipped++; console.log(`SKIP ${file} ${name}: fixture unavailable (${a.value.setupFailed})`); }
          continue;
        }
        const equal = util.isDeepStrictEqual(a, b);
        const intentional = Object.hasOwn(B, name) ? B[name] : undefined, feature = Object.hasOwn(F, name) ? F[name] : undefined;
        if (strict) {
          if (equal) { same++; if (a.error && process.env.PARITY_VERBOSE_ERRORS) console.log(`SAME-ERROR ${file} ${name}: ${a.error.name}: ${a.error.message}`); continue; }
          differ++;
          const declared = intentional || feature;
          show('DIFF', file, name, a, b, declared ? ` (declared ${declared.unit} is not accepted by the strict policy)` : '');
          continue;
        }
        if (intentional) {
          if (equal) { errors++; console.log(`ERROR ${file} ${name}: stale ${intentional.unit} declaration, the trees no longer differ`); continue; }
          if (capturePath) { (captured[file] ||= {})[name] = { unit: intentional.unit, up: a, ours: b }; expected++; show('EXPECTED', file, name, a, b, ` [${intentional.unit}: ${intentional.reason}]`); continue; }
          const brokenSide = [['upstream', a], ['ours', b]].filter(([, r]) => brokenCode(r)).map(([side]) => side);
          if (brokenSide.length) { differ++; show('DIFF', file, name, a, b, `: ${brokenSide.join(', ')} threw a SyntaxError or ReferenceError, which is never an accepted ${intentional.unit} observation`); continue; }
          const pin = Object.hasOwn(pins, name) ? pins[name] : undefined;
          if (!pin) { errors++; console.log(`ERROR ${file} ${name}: ${intentional.unit} difference has no pinned observation in ${FIXTURE}`); continue; }
          const drift = [pin.unit !== intentional.unit && 'unit', !util.isDeepStrictEqual(pin.up, a) && 'upstream', !util.isDeepStrictEqual(pin.ours, b) && 'ours'].filter(Boolean);
          if (drift.length) {
            differ++;
            show('DIFF', file, name, a, b, `: drifted from the pinned ${intentional.unit} observation (${drift.join(', ')})`);
            console.log(`  pinned upstream: ${JSON.stringify(pin.up)}\n  pinned ours:     ${JSON.stringify(pin.ours)}${drift.includes('unit') ? `\n  pinned unit: ${pin.unit}` : ''}`);
            continue;
          }
          expected++; show('EXPECTED', file, name, a, b, ` [${intentional.unit}: ${intentional.reason}]`); continue;
        }
        if (feature) {
          if (equal) { errors++; console.log(`ERROR ${file} ${name}: stale ${feature.unit} declaration, the trees no longer differ`); continue; }
          if (a.error || b.error) { differ++; show('DIFF', file, name, a, b, `: unexpected thrown error in a ${feature.unit} case`); continue; }
          features++; show('FEATURE', file, name, a, b, ` [${feature.unit}: ${feature.reason}]`); continue;
        }
        if (equal) { same++; if (a.error && process.env.PARITY_VERBOSE_ERRORS) console.log(`SAME-ERROR ${file} ${name}: ${a.error.name}: ${a.error.message}`); continue; }
        differ++; show('DIFF', file, name, a, b);
      }
    } catch (e) { errors++; console.log(`ERROR ${file}: ${e.stack || e}`); }
  }
  if (!same && !expected && !features && !differ && !errors) { errors++; console.log('ERROR No cases matched PARITY_NAME'); }
  if (capturePath && !differ && !errors) { fs.writeFileSync(capturePath, serialize(captured)); console.log(`CAPTURED ${expected} B observations to ${capturePath}`); }
  console.log(`${process.platform} node ${process.version}: ${same} same, ${expected} expected (B), ${features} feature divergences (F), ${differ} unexpected, ${errors} errors, ${skipped} skipped`);
  process.exitCode = differ || errors ? 1 : 0;
})().catch((e) => { console.error(`ERROR ${e.stack || e}`); process.exitCode = 1; });
