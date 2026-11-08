'use strict';
// Going private, step B (Anthony 2026-11-04; SERVER_RULES.md rules 6.1, 6.8 and 8.7): the guard on every workflow in
// .github/workflows and on requirements-box-ci.txt.
//   - No job anywhere runs on a GitHub-hosted Windows or macOS image (runs-on or a matrix list).
//   - The Windows gate is unit-windows in test.yml, on exactly [self-hosted, Windows, homeserver] (nt8/update-pc.ps1
//     waits for exactly that name).
//   - No job calls a reusable workflow from another repo (its runners cannot be read here).
//   - A job is self-hosted unless every label of its runs-on (one line or a block list) is a GitHub image name; an
//     expression or a runner group counts as self-hosted.
//   - Every self-hosted job installs nothing from npm, yarn, pnpm, corepack, npx, uv or pipx, runs `npm ci` only with
//     --ignore-scripts, runs pip only with --require-hashes and --only-binary :all:, checks out without leaving the
//     token behind (persist-credentials: false), and has no concurrency of its own; a file with a self-hosted job has
//     no workflow-level concurrency (rule 6.8: nothing a push sets off cancels a box job, running or queued).
// Plain text reading, no YAML library (the tests need no package).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const WORKFLOWS = path.join(root, '.github', 'workflows');
const BOX_REQS = path.join(root, 'requirements-box-ci.txt');
const BOX_RUNNER = '[self-hosted, Windows, homeserver]';

// A line without its comment: a # at the start (after the indentation) or after a space, outside single and double
// quotes, as YAML and the shells read it. A # inside quotes (echo "x #y") is kept.
function stripComment(line) {
  let q = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === q) q = ''; else if (c === '\\' && q === '"') i++; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}
function codeLines(text) {
  return text.split(/\r?\n/).map(l => stripComment(l).replace(/\s+$/, ''));
}
const indentOf = l => l.length - l.trimStart().length;

// The workflow-level lines (every line outside `jobs:`) and the jobs, each as its own lines.
function parse(text) {
  const lines = codeLines(text);
  const top = [], jobs = {};
  let inJobs = false, name = null, indent = -1;
  for (const line of lines) {
    if (!line.trim()) continue;
    const ind = indentOf(line);
    if (ind === 0) { inJobs = line === 'jobs:'; name = null; indent = -1; if (!inJobs) top.push(line); continue; }
    if (!inJobs) { top.push(line); continue; }
    const m = /^(\s+)([A-Za-z0-9_-]+):$/.exec(line);
    if (m && (indent < 0 || ind <= indent)) { name = m[2]; indent = ind; jobs[name] = []; continue; }
    if (name) jobs[name].push(line);
  }
  return { top, jobs };
}

// A job's runs-on as one text: the one-line form as written, a block list (- a / - b) as [a, b], any other block (a
// runner group, labels) as its lines joined. null when the job has none (a job that calls a reusable workflow).
function runsOn(lines) {
  const i = lines.findIndex(l => /^\s*runs-on:/.test(l));
  if (i < 0) return null;
  const inline = lines[i].replace(/^\s*runs-on:\s*/, '').trim();
  if (inline) return inline;
  const ind = indentOf(lines[i]), block = [];
  for (const n of lines.slice(i + 1)) { if (indentOf(n) <= ind) break; block.push(n.trim()); }
  if (block.length && block.every(b => /^-\s+\S/.test(b))) return '[' + block.map(b => b.replace(/^-\s+/, '').replace(/^['"]|['"]$/g, '')).join(', ') + ']';
  return block.join(' ');
}

// GitHub's hosted images by name; a job is self-hosted unless every label of its runs-on is one of them. An expression
// (${{ ... }}, fromJSON) or a runner group cannot be read here, so it counts as self-hosted.
const HOSTED_LABEL = /^(?:ubuntu-(?:latest|slim|\d{2}\.\d{2}(?:-arm)?)|windows-(?:latest|20\d\d|11-arm)|macos-(?:latest|\d+)(?:-large|-xlarge|-intel)?)$/;
function selfHosted(value) {
  if (value === null) return false;
  if (/\$\{\{/.test(value) || /:/.test(value)) return true;
  const labels = value.replace(/^\[|\]$/g, '').split(',').map(x => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  return labels.length === 0 || !labels.every(x => HOSTED_LABEL.test(x));
}

// A GitHub-hosted Windows or macOS image (windows-latest, windows-2022, windows-11-arm, macos-14, ...).
function hostedProblem(value) {
  if (/(^|[\s,[\]'"])(windows|win)-[\w.-]+/i.test(value)) return 'a GitHub-hosted Windows image';
  if (/macos/i.test(value)) return 'a macOS image';
  return null;
}

// What a self-hosted job may not run, line by line (rule 8.7). A command "at the start of a statement": after the
// indentation, a list dash, `run:`, or ; & | ( { ` then do, as the shells start a command.
const AT_START = String.raw`(?:^\s*(?:-\s+)?(?:run:\s*)?(?:[|>][-+]?\s*)?|[;&|({` + '`' + String.raw`]\s*|\b(?:then|do|else)\s+)`;
const PIP = /(?:^|[\s;&|(`'"])(?:pip3?(?:\.exe)?|(?:py|python3?)(?:\.exe)?(?:\s+-[\w.]+)*\s+-m\s+pip)\s+install\b/i;
const FORBIDDEN = [
  [/(?:^|[\s;&|(`'"])npx\b/, 'npx'],
  [/\bnpm\s+(?:install|i|in|isntall|add|exec|x)\b/, 'an npm install or npm exec'],
  [new RegExp(AT_START + String.raw`(?:yarn|pnpm|corepack)(?:\.cmd|\.exe)?(?=\s|$)`), 'yarn, pnpm or corepack'],
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
  const boxJobs = Object.keys(jobs).filter(n => selfHosted(runsOn(jobs[n])));
  // rule 6.8: nothing a push sets off may cancel a self-hosted job, so a file with one has no workflow-level
  // concurrency at all (any form), and the self-hosted job none of its own
  if (boxJobs.length) for (const l of top) if (/^concurrency:/.test(l)) {
    problems.push(`${file}: a workflow-level concurrency in a file with a self-hosted job (${boxJobs.join(', ')}): ${l.trim()}`);
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
    if (r === null && lines.some(l => { const m = /^\s*uses:\s*(\S+)/.exec(l); return m && !m[1].startsWith('./') && indentOf(l) === indentOf(lines[0]); })) {
      problems.push(`${job} calls a reusable workflow from elsewhere, whose runners this check cannot read`);
    }
    if (boxJobs.includes(name)) {
      problems.push(...installProblems(job, lines), ...checkoutProblems(job, lines));
      for (const l of lines) if (/^\s*concurrency:/.test(l)) problems.push(`${job}: a concurrency on a self-hosted job (rule 6.8): ${l.trim()}`);
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
  const wf = (runsOnLines, cmd) => `name: other\non: push\njobs:\n  extra:\n${runsOnLines}    steps:\n      - run: ${cmd}\n`;
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
    // the re-review's false passes (2026-11-08)
    ['runs-on as a block list', { 'test.yml': ok, 'box.yml': wf('    runs-on:\n      - self-hosted\n      - Windows\n', 'python -m pip install numpy') }],
    ['runs-on as an expression', { 'test.yml': ok, 'box.yml': wf('    runs-on: ${{ fromJSON(inputs.runner) }}\n', 'python -m pip install numpy') }],
    ['runs-on as a runner group', { 'test.yml': ok, 'box.yml': wf('    runs-on:\n      group: box\n      labels: [Windows]\n', 'npm install') }],
    ['runs-on as a label that is not a GitHub image', { 'test.yml': ok, 'box.yml': wf('    runs-on: ubuntu-homeserver\n', 'pip install numpy') }],
    ['a workflow-level concurrency group without cancel-in-progress', { 'test.yml': edited('permissions:\n  contents: read\n', 'concurrency:\n  group: test-${{ github.ref }}\npermissions:\n  contents: read\n') }],
    ['a one-line workflow-level concurrency', { 'test.yml': edited('permissions:\n  contents: read\n', 'concurrency: test-${{ github.ref }}\npermissions:\n  contents: read\n') }],
    ['a workflow-level concurrency after jobs', { 'test.yml': ok + 'concurrency: late\n' }],
    ['a box job with a group and cancel-in-progress false', { 'test.yml': edited(`    runs-on: ${BOX_RUNNER}\n`, `    runs-on: ${BOX_RUNNER}\n    concurrency:\n      group: box\n      cancel-in-progress: false\n`) }],
    ['a one-line concurrency on the box job', { 'test.yml': edited(`    runs-on: ${BOX_RUNNER}\n`, `    runs-on: ${BOX_RUNNER}\n    concurrency: box\n`) }],
    ['pip after a # in double quotes', { 'test.yml': inBox('echo "x #y" && pip install numpy') }],
    ['yarn after a # in single quotes', { 'test.yml': inBox("echo 'a #b'; yarn install") }],
    ['yarn in a block script', { 'test.yml': inBox('|\n          echo start\n          yarn install') }],
    ['pnpm after &&', { 'test.yml': inBox('cd x && pnpm i') }],
    ['corepack', { 'test.yml': inBox('corepack yarn install') }],
    ['a reusable workflow from another repo', { 'test.yml': ok, 'call.yml': 'name: call\non: push\njobs:\n  call:\n    uses: someone/else/.github/workflows/x.yml@v1\n' }],
  ];
  for (const [what, files] of cases) assert.ok(workflowProblems(files).length > 0, `${what}: caught`);
  // what the guard must let through (no false fails)
  const linuxOnly = 'name: lint\non: pull_request\nconcurrency:\n  group: lint-${{ github.ref }}\n  cancel-in-progress: true\njobs:\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm install && yarn lint\n';
  const fine = [
    ['a Linux-only workflow with its own cancelling concurrency', { 'test.yml': ok, 'lint.yml': linuxOnly }],
    ['a hosted job as a block list', { 'test.yml': ok, 'more.yml': wf('    runs-on:\n      - ubuntu-24.04\n', 'pip install numpy') }],
    ['a local reusable workflow', { 'test.yml': ok, 'call.yml': 'name: call\non: push\njobs:\n  call:\n    uses: ./.github/workflows/test.yml\n' }],
  ];
  for (const [what, files] of fine) assert.deepEqual(workflowProblems(files), [], `allowed: ${what}`);
  for (const cmd of ['npm run check-no-yarn', 'echo "no yarn or pnpm here"', 'echo hi # pip install numpy', 'node tools/yarn-free.js',
    'echo "#" && npm test']) {
    assert.deepEqual(workflowProblems({ 'test.yml': ok.replace(boxRun, `        run: ${cmd}\n`) }), [], `allowed: ${cmd}`);
  }
  for (const cmd of ['npm ci --ignore-scripts', 'npm test', 'npm run test:markup', 'python -m pip install --require-hashes --only-binary :all: -r requirements-box-ci.txt']) {
    assert.deepEqual(workflowProblems({ 'test.yml': ok.replace(boxRun, `        run: ${cmd}\n`) }), [], `allowed: ${cmd}`);
  }
  assert.ok(reqProblems('numpy==2.5.4\n').length === 1, 'a requirement without a hash is caught');
  assert.ok(reqProblems('numpy==2.5.4 \\\n    --hash=sha256:' + 'a'.repeat(64) + '\n').length === 0, 'a hash on a continuation line counts');
});
