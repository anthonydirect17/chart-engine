'use strict';
// SERVER_RULES.md rule 6.5 (going private, step B): a test server binds 127.0.0.1 on port 0, never a chosen port or
// 0.0.0.0, and the test learns the port the system picked. This reads every test/*.test.js and every test/ helper they
// load or start (followed through the helpers' own imports) and fails on:
//   - a .listen( whose port is a number other than 0, or a variable that is not one of the two below, or no port;
//   - a .listen( on any address but '127.0.0.1';
//   - fake-bridge.mjs started anywhere but test/fake-bridge-start.js, or started there without port '0';
//   - startDesk( (test/fake-desk.mjs) called by a test with a port other than 0;
//   - a port picked with Math.random (the old way: a random fixed port).
// The two variables allowed: fake-bridge.mjs's PORT (its command line port, 8765 by default for `npm run bridge` by
// hand; the tests start it with 0 through fake-bridge-start.js) and fake-desk.mjs's startDesk(port) (the smoke runs on
// a PC pass their own; the unit tests pass 0). Plain text reading, no dependencies.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dir = __dirname;
const ALLOWED_VARIABLE_PORTS = { 'fake-bridge.mjs': 'PORT', 'fake-desk.mjs': 'port' };

// Comments out (line comments and block comments; good enough for these files, which keep no // inside strings that
// matter here: a URL's // follows a ':' and is kept).
function code(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
}

// The test/ files a file loads or starts: require('./x'), import('./x'), import ... from './x', and every .mjs or .js
// named in a spawn, fork or exec call. A file a test only reads as text (a smoke script's source, say) is not run by
// npm test and is not counted.
function loaded(text) {
  const names = [];
  for (const m of text.matchAll(/\b(?:require|import)\(\s*['"]\.\/([\w.-]+)['"]\s*\)|\bfrom\s+['"]\.\/([\w.-]+)['"]/g)) names.push(m[1] || m[2]);
  for (const m of text.matchAll(/\b(?:spawn|spawnSync|fork|execFile|execFileSync|exec|execSync)\s*\([^;]*/g)) {
    for (const n of m[0].matchAll(/['"]([\w.-]+\.(?:mjs|js))['"]/g)) names.push(n[1]);
  }
  return names;
}

// The test files (test/*.test.js) and every test/ file they load or start, followed through.
function filesInScope() {
  // this file holds made-up bad code for its own check, so it is left out
  const tests = fs.readdirSync(dir).filter(f => f.endsWith('.test.js') && f !== path.basename(__filename));
  const seen = new Set(tests), queue = tests.slice();
  while (queue.length) {
    const f = queue.shift();
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const name of loaded(text)) {
      if (!seen.has(name) && fs.existsSync(path.join(dir, name))) { seen.add(name); queue.push(name); }
    }
  }
  return [...seen].sort();
}

// The first two arguments of each .listen( call (a server's, not a feed's .listen({ ... })).
function listenCalls(src) {
  const out = [];
  for (const m of src.matchAll(/\.listen\(\s*([^,)]*?)\s*(?:,\s*([^,)]*?)\s*)?[,)]/g)) {
    if (m[1].startsWith('{')) continue;
    out.push({ port: m[1], host: m[2] || '', text: m[0] });
  }
  return out;
}

function portProblems(name, text) {
  const src = code(text), problems = [];
  // .listen({ port, host }): a server's options object (a feed's .listen({ message, closed }) names no port)
  for (const m of src.matchAll(/\.listen\(\s*\{([^}]*)\}/g)) {
    if (!/\bport\s*:/.test(m[1])) continue;
    if (!/\bport\s*:\s*0\b/.test(m[1])) problems.push(`${name}: .listen({${m[1]}}) does not listen on port 0`);
    if (!/\bhost\s*:\s*'127\.0\.0\.1'/.test(m[1])) problems.push(`${name}: .listen({${m[1]}}) does not bind '127.0.0.1'`);
  }
  for (const c of listenCalls(src)) {
    if (c.port === '') problems.push(`${name}: ${c.text} has no port (the system would pick one on every address)`);
    else if (/^\d+$/.test(c.port)) { if (+c.port !== 0) problems.push(`${name}: ${c.text} listens on port ${c.port}, not 0`); }
    else if (ALLOWED_VARIABLE_PORTS[name] !== c.port) problems.push(`${name}: ${c.text} listens on ${c.port}, which this check cannot see is 0`);
    if (c.port !== '' && c.host !== "'127.0.0.1'") problems.push(`${name}: ${c.text} does not bind '127.0.0.1'`);
  }
  for (const m of src.matchAll(/\b(?:spawn|spawnSync|fork|execFile|execFileSync|exec|execSync)\s*\([^;]*?fake-(?:bridge|desk)\.mjs[^;]*/g)) {
    if (name !== 'fake-bridge-start.js') problems.push(`${name}: starts a fake server itself (use fake-bridge-start.js, which starts it on port 0): ${m[0].slice(0, 120)}`);
    else if (!/fake-bridge\.mjs'\),\s*'0'/.test(m[0])) problems.push(`${name}: fake-bridge.mjs not started with port '0'`);
  }
  for (const m of src.matchAll(/\bstartDesk\(\s*([^,)]*)/g)) {
    if (name.endsWith('.test.js') && m[1].trim() !== '0') problems.push(`${name}: startDesk(${m[1]}, ...) instead of startDesk(0, ...)`);
  }
  for (const line of src.split('\n')) {
    if (/Math\.random\(\)/.test(line) && /port/i.test(line)) problems.push(`${name}: a random fixed port: ${line.trim()}`);
  }
  return problems;
}

test('test ports (rule 6.5): every test server binds 127.0.0.1 on port 0 and the test learns the port', () => {
  const files = filesInScope();
  const problems = files.flatMap(f => portProblems(f, fs.readFileSync(path.join(dir, f), 'utf8')));
  assert.deepEqual(problems, [], problems.join('\n'));
  for (const helper of ['fake-bridge.mjs', 'fake-desk.mjs', 'fake-bridge-start.js', 'fake-bot.mjs', 'fake-v3.mjs']) {
    assert.ok(files.includes(helper), `${helper} is in scope (the tests load it)`);
  }
  const start = fs.readFileSync(path.join(dir, 'fake-bridge-start.js'), 'utf8');
  assert.match(start, /fake-bridge\.mjs'\),\s*'0'\]/, 'fake-bridge-start.js starts the bridge with port 0');
  assert.match(fs.readFileSync(path.join(dir, 'fake-bridge.mjs'), 'utf8'), /PORT = server\.address\(\)\.port/, 'the bridge reports the port it was given');
});

test('test ports: the check catches what it should (made-up code)', () => {
  const bad = [
    ['x.test.js', "server.listen(8765, '127.0.0.1');"],
    ['x.test.js', "srv.listen(18000 + n, '127.0.0.1', r);"],
    ['x.test.js', "srv.listen(p, '127.0.0.1', r);"],
    ['x.test.js', "srv.listen(0, '0.0.0.0', r);"],
    ['x.test.js', 'srv.listen(0, r);'],
    ['x.test.js', 'srv.listen();'],
    ['x.test.js', "const child = spawn(process.execPath, [path.join(__dirname, 'fake-bridge.mjs'), '0']);"],
    ['x.test.js', "const desk = await startDesk(18001, {});"],
    ['x.test.js', 'const port = 19000 + Math.floor(Math.random() * 900);'],
    ['fake-bridge-start.js', "spawn(process.execPath, [path.join(__dirname, 'fake-bridge.mjs'), '8765'])"],
    ['fake-desk.mjs', "server.listen(8800, '127.0.0.1', r);"],
    ['x.test.js', "server.listen({ port: 8765, host: '127.0.0.1' });"],
    ['x.test.js', "server.listen({ port: 0 });"],
  ];
  for (const [name, text] of bad) assert.ok(portProblems(name, text).length > 0, `caught: ${name}: ${text}`);
  const good = [
    ['x.test.js', "srv.listen(0, '127.0.0.1', () => r(srv.address().port));"],
    ['x.test.js', "const off = F.feed.listen({ message: m => heard.push(m.type) });"],
    ['x.test.js', "const desk = await startDesk(0, { types: [] });"],
    ['fake-desk.mjs', "await new Promise(r => server.listen(port, '127.0.0.1', r));"],
    ['fake-bridge.mjs', "pinReady.then(() => server.listen(PORT, '127.0.0.1', () => {"],
    ['fake-bridge-start.js', "spawn(process.execPath, [path.join(__dirname, 'fake-bridge.mjs'), '0'].concat(flags || []))"],
    ['x.test.js', "// srv.listen(8765, '127.0.0.1') in a comment"],
    ['x.test.js', "server.listen({ port: 0, host: '127.0.0.1' }, r);"],
  ];
  for (const [name, text] of good) assert.deepEqual(portProblems(name, text), [], `allowed: ${name}: ${text}`);
});
