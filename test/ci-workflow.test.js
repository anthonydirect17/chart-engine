'use strict';
// Going private, step B (Anthony 2026-11-04; SERVER_RULES.md rules 6.1, 6.8 and 8.7): the guard on every workflow in
// .github/workflows and on requirements-box-ci.txt.
//   - No job anywhere runs on a GitHub-hosted Windows or macOS image (runs-on or a matrix list).
//   - The Windows gate is unit-windows in test.yml, on exactly [self-hosted, Windows, homeserver] (nt8/update-pc.ps1
//     waits for exactly that name).
//   - Every job on a self-hosted runner installs nothing from npm, yarn, pnpm, npx or uv, runs `npm ci` only with
//     --ignore-scripts, runs pip only with --require-hashes and --only-binary :all:, checks out without leaving the
//     token behind (persist-credentials: false), and is never cancelled by a push (no cancel-in-progress but false,
//     and no workflow-wide concurrency that cancels).
// Plain text reading, no YAML library (the tests need no package).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const WORKFLOWS = path.join(root, '.github', 'workflows');
const BOX_REQS = path.join(root, 'requirements-box-ci.txt');
const BOX_RUNNER = '[self-hosted, Windows, homeserver]';

// The workflow's lines without comments (a # at the start of a line or after a space; no value here holds one).
function codeLines(text) {
  return text.split(/\r?\n/).map(l => l.replace(/(^|\s)#.*$/, '').replace(/\s+$/, ''));
}

// The top-level lines (indent 0 keys and what is under them) and the jobs under `jobs:`, each as its own lines.
function parse(text) {
  const lines = codeLines(text);
  const start = lines.findIndex(l => l === 'jobs:');
  const top = start < 0 ? lines : lines.slice(0, start);
  const jobs = {};
  let name = null, indent = -1;
  if (start >= 0) {
    for (const line of lines.slice(start + 1)) {
      if (!line.trim()) continue;
      const ind = line.length - line.trimStart().length;
      if (ind === 0) break;                                 // the next top-level key
      const m = /^(\s+)([A-Za-z0-9_-]+):$/.exec(line);
      if (m && (indent < 0 || ind <= indent)) { name = m[2]; indent = ind; jobs[name] = []; continue; }
      if (name) jobs[name].push(line);
    }
  }
  return { top, jobs };
}

function runsOn(lines) {
  const hit = lines.find(l => /^\s*runs-on:/.test(l));
  return hit ? hit.replace(/^\s*runs-on:\s*/, '').trim() : null;
}

// A GitHub-hosted Windows or macOS image (windows-latest, windows-2022, windows-11-arm, macos-14, ...).
function hostedProblem(value) {
  if (/(^|[\s,[\]'"])(windows|win)-[\w.-]+/i.test(value)) return 'a GitHub-hosted Windows image';
  if (/macos/i.test(value)) return 'a macOS image';
  return null;
}

// What a self-hosted job may not run, line by line (rule 8.7).
const PIP = /(?:^|[\s;&|(`'"])(?:pip3?(?:\.exe)?|(?:py|python3?)(?:\.exe)?(?:\s+-[\w.]+)*\s+-m\s+pip)\s+install\b/i;
const FORBIDDEN = [
  [/(?:^|[\s;&|(`'"])npx\b/, 'npx'],
  [/\bnpm\s+(?:install|i|in|isntall|add|exec|x)\b/, 'an npm install or npm exec'],
  [/\b(?:yarn|pnpm)\b/, 'yarn or pnpm'],
  [/\buv\s+(?:add|sync|pip\s+install|tool\s+install|run)\b|\buvx\b/, 'uv installing packages'],
  [/\bpipx\b/, 'pipx'],
];
function installProblems(job, lines) {
  const out = [];
  for (const l of lines) {
    const t = l.trim();
    for (const [re, what] of FORBIDDEN) if (re.test(l)) out.push(`${job} runs ${what}: ${t}`);
    if (/\bnpm\s+(?:ci|clean-install|install-clean|isntall-clean|ic)\b/.test(l) && !/--ignore-scripts\b/.test(l)) out.push(`${job} runs npm ci without --ignore-scripts: ${t}`);
    if (PIP.test(l) && !(/--require-hashes\b/.test(l) && /--only-binary[\s=]+:all:/.test(l))) {
      out.push(`${job} runs pip install without --require-hashes and --only-binary :all:: ${t}`);
    }
  }
  return out;
}

// actions/checkout in a self-hosted job: persist-credentials: false in its `with:`.
function checkoutProblems(job, lines) {
  const out = [];
  lines.forEach((l, i) => {
    if (!/^\s*-?\s*uses:\s*actions\/checkout@/.test(l)) return;
    const ind = l.length - l.trimStart().length;
    const step = [];
    for (const n of lines.slice(i + 1)) {                  // the rest of this step: until the next step or the job's end
      if (!n.trim()) continue;
      const ni = n.length - n.trimStart().length;
      if (ni < ind || (ni === ind && /^\s*-\s/.test(n))) break;
      step.push(n);
    }
    if (!step.some(n => /^\s*persist-credentials:\s*false\s*$/.test(n))) out.push(`${job}: actions/checkout without persist-credentials: false`);
  });
  return out;
}

// One workflow file's problems.
function fileProblems(file, text) {
  const problems = [];
  const { top, jobs } = parse(text);
  const topCancel = top.filter(l => /^\s+cancel-in-progress:/.test(l));
  for (const l of topCancel) {
    if (!/cancel-in-progress:\s*false$/.test(l)) problems.push(`${file}: a workflow-wide concurrency that can cancel a self-hosted job: ${l.trim()}`);
  }
  for (const [name, lines] of Object.entries(jobs)) {
    const job = `${file} ${name}`;
    const r = runsOn(lines);
    const bad = r && hostedProblem(r);
    if (bad) problems.push(`${job} runs on ${bad}: ${r}`);
    // a matrix that feeds runs-on: `os: [...]`, `- os: ...` or a bare list item
    for (const l of lines) if (/^\s*(-\s+)?os:/.test(l) || /^\s*-\s+[\w.-]+\s*$/.test(l)) {
      const b = hostedProblem(l);
      if (b) problems.push(`${job} names ${b}: ${l.trim()}`);
    }
    if (r && /self-hosted/i.test(r)) {
      problems.push(...installProblems(job, lines), ...checkoutProblems(job, lines));
      for (const l of lines) if (/^\s*cancel-in-progress:/.test(l) && !/cancel-in-progress:\s*false$/.test(l)) {
        problems.push(`${job}: a self-hosted job a push could cancel (rule 6.8): ${l.trim()}`);
      }
    }
  }
  return problems;
}

// Every workflow: { 'test.yml': text, ... }. test.yml must hold unit-windows on the box runner.
function workflowProblems(files) {
  const problems = [];
  for (const [file, text] of Object.entries(files)) problems.push(...fileProblems(file, text));
  const main = files['test.yml'];
  const box = main === undefined ? null : parse(main).jobs['unit-windows'];
  if (!box) problems.push('test.yml has no job named unit-windows (nt8/update-pc.ps1 waits for exactly that name)');
  else if (runsOn(box) !== BOX_RUNNER) problems.push(`test.yml unit-windows runs on ${runsOn(box)}, not ${BOX_RUNNER}`);
  return problems;
}

function readWorkflows() {
  const out = {};
  for (const f of fs.readdirSync(WORKFLOWS).filter(f => /\.ya?ml$/.test(f)).sort()) out[f] = fs.readFileSync(path.join(WORKFLOWS, f), 'utf8');
  return out;
}

// The requirement lines of a requirements file, continuation lines joined.
function requirementLines(text) {
  const joined = text.replace(/\\\r?\n/g, ' ');
  return joined.split(/\r?\n/).map(l => l.replace(/(^|\s)#.*$/, '').trim()).filter(l => l && !l.startsWith('-'));
}

function reqProblems(text) {
  return requirementLines(text).filter(l => !/--hash=sha256:[0-9a-f]{64}\b/.test(l)).map(l => `no --hash=sha256: on ${l}`);
}

test('ci-workflow: every workflow: no hosted Windows or macOS; unit-windows on HOMESERVER; self-hosted jobs install nothing unhashed (rules 6.1, 6.8, 8.7)', () => {
  const files = readWorkflows();
  assert.ok(files['test.yml'], 'test.yml is there');
  const problems = workflowProblems(files);
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('ci-workflow: unit-windows installs requirements-box-ci.txt, and every line of it has a sha256 hash', () => {
  const box = parse(readWorkflows()['test.yml']).jobs['unit-windows'];
  assert.ok(box.some(l => /pip install .*-r requirements-box-ci\.txt/.test(l)), 'the box job installs from requirements-box-ci.txt');
  const text = fs.readFileSync(BOX_REQS, 'utf8');
  assert.ok(requirementLines(text).length > 0, 'requirements-box-ci.txt names a package');
  const problems = reqProblems(text);
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('ci-workflow: the Linux job runs on pull requests only, the box job on main and non-draft pull requests into main', () => {
  const { jobs } = parse(readWorkflows()['test.yml']);
  assert.ok(jobs['unit-linux'], 'a unit-linux job');
  assert.ok(jobs['unit-linux'].some(l => /^\s*if:.*github\.event_name == 'pull_request'/.test(l)), 'unit-linux: pull requests only');
  assert.equal(runsOn(jobs['unit-linux']), 'ubuntu-latest');
  assert.ok(jobs['unit-windows'].some(l => /^\s*if:\s*github\.event_name == 'push' \|\| \(github\.base_ref == 'main' && github\.event\.pull_request\.draft == false\)$/.test(l)),
    'unit-windows: pushes to main and pull requests into main that are not drafts');
  assert.ok(!jobs['unit-windows'].some(l => /^\s*concurrency:/.test(l)), 'unit-windows has no concurrency group: a newer job never cancels it, running or queued');
});

test('ci-workflow: the guard itself catches what it should (made-up workflows)', () => {
  const ok = readWorkflows()['test.yml'];
  assert.deepEqual(workflowProblems({ 'test.yml': ok }), []);
  const boxRun = '        run: npm test\n';
  assert.ok(ok.includes(boxRun), 'the made-up changes below have their anchor');
  // a change to test.yml that must really change it (no case passes for want of its anchor)
  const edited = (from, to) => { const t = ok.replace(from, to); assert.notEqual(t, ok, `the made-up change applies: ${from}`); return t; };
  const inBox = cmd => edited(boxRun, `        run: ${cmd}\n`);
  const extra = (runs, cmd) => `name: other\non: push\njobs:\n  extra:\n    runs-on: ${runs}\n    steps:\n      - run: ${cmd}\n`;
  const cases = [
    ['a hosted Windows job', { 'test.yml': edited('runs-on: ubuntu-latest', 'runs-on: windows-latest') }],
    ['a dated Windows image', { 'test.yml': edited('runs-on: ubuntu-latest', 'runs-on: windows-2022') }],
    ['macOS', { 'test.yml': edited('runs-on: ubuntu-latest', 'runs-on: macos-14') }],
    ['a matrix list', { 'test.yml': edited('runs-on: ubuntu-latest', 'strategy:\n      matrix:\n        os: [ubuntu-latest, windows-latest]\n    runs-on: ${{ matrix.os }}') }],
    ['a hosted Windows job in another workflow', { 'test.yml': ok, 'other.yaml': extra('windows-latest', 'echo hi') }],
    ['the box job renamed', { 'test.yml': edited(/^ {2}unit-windows:$/m, '  windows:') }],
    ['the box job on another runner', { 'test.yml': edited(`runs-on: ${BOX_RUNNER}`, 'runs-on: [self-hosted, Windows]') }],
    ['no test.yml', { 'other.yml': ok }],
    ['npm install', { 'test.yml': inBox('npm install --no-package-lock') }],
    ['npm i', { 'test.yml': inBox('npm i playwright') }],
    ['npm ci without --ignore-scripts', { 'test.yml': inBox('npm ci') }],
    ['npx', { 'test.yml': inBox('npx playwright test') }],
    ['npm exec', { 'test.yml': inBox('npm exec -- playwright test') }],
    ['yarn', { 'test.yml': inBox('yarn install --frozen-lockfile') }],
    ['pnpm', { 'test.yml': inBox('pnpm install') }],
    ['uv add', { 'test.yml': inBox('uv add numpy') }],
    ['uv sync', { 'test.yml': inBox('uv sync') }],
    ['uv pip install', { 'test.yml': inBox('uv pip install numpy') }],
    ['pip install', { 'test.yml': inBox('pip install numpy') }],
    ['pip3 install', { 'test.yml': inBox('pip3 install --require-hashes numpy') }],
    ['py -m pip', { 'test.yml': inBox('py -3.12 -m pip install --only-binary :all: numpy') }],
    ['python -m pip', { 'test.yml': inBox('python -m pip install -r requirements-box-ci.txt') }],
    ['the box pip without hashes', { 'test.yml': edited('--require-hashes --only-binary :all: --target', '--target') }],
    ['another self-hosted job', { 'test.yml': ok, 'box.yml': extra('[self-hosted, Windows, homeserver]', 'python -m pip install numpy') }],
    ['checkout keeping the token', { 'test.yml': edited('          persist-credentials: false\n', '          fetch-depth: 1\n') }],
    ['a box job a push can cancel', { 'test.yml': edited(`    runs-on: ${BOX_RUNNER}\n`, `    runs-on: ${BOX_RUNNER}\n    concurrency:\n      group: box\n      cancel-in-progress: true\n`) }],
    ['a workflow-wide cancel', { 'test.yml': edited('permissions:\n  contents: read\n', 'concurrency:\n  group: test-${{ github.ref }}\n  cancel-in-progress: ${{ github.event_name == \'pull_request\' }}\npermissions:\n  contents: read\n') }],
  ];
  for (const [what, files] of cases) assert.ok(workflowProblems(files).length > 0, `${what}: caught`);
  for (const cmd of ['npm ci --ignore-scripts', 'npm test', 'npm run test:markup', 'python -m pip install --require-hashes --only-binary :all: -r requirements-box-ci.txt']) {
    assert.deepEqual(workflowProblems({ 'test.yml': ok.replace(boxRun, `        run: ${cmd}\n`) }), [], `allowed: ${cmd}`);
  }
  assert.ok(reqProblems('numpy==2.5.4\n').length === 1, 'a requirement without a hash is caught');
  assert.ok(reqProblems('numpy==2.5.4 \\\n    --hash=sha256:' + 'a'.repeat(64) + '\n').length === 0, 'a hash on a continuation line counts');
});
