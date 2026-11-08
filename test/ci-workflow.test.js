'use strict';
// Going private, step B (Anthony 2026-11-04; SERVER_RULES.md rules 6.1, 6.5 and 8.7): the guard on
// .github/workflows/test.yml and requirements-box-ci.txt. The Windows gate runs on HOMESERVER's self-hosted runner as
// unit-windows (nt8/update-pc.ps1 waits for exactly that name), never on a GitHub-hosted Windows or macOS image; the box
// job installs nothing from npm and Python packages only hash-checked, binary wheels only. Plain text reading, no YAML
// library (the tests need no package).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const WORKFLOW = path.join(root, '.github', 'workflows', 'test.yml');
const BOX_REQS = path.join(root, 'requirements-box-ci.txt');
const BOX_RUNNER = '[self-hosted, Windows, homeserver]';

// The workflow's lines without comments (a # at the start of a line or after a space; no value here holds one).
function codeLines(text) {
  return text.split(/\r?\n/).map(l => l.replace(/(^|\s)#.*$/, '').replace(/\s+$/, ''));
}

// The jobs under `jobs:`, each as its name and its own lines (the lines indented deeper than its name).
function jobs(text) {
  const lines = codeLines(text);
  const start = lines.findIndex(l => l === 'jobs:');
  assert.ok(start >= 0, 'test.yml has a top-level jobs: section');
  const out = {};
  let name = null, indent = -1;
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) continue;
    const ind = line.length - line.trimStart().length;
    if (ind === 0) break;                                   // the next top-level key
    const m = /^(\s+)([A-Za-z0-9_-]+):$/.exec(line);
    if (m && (indent < 0 || ind <= indent)) { name = m[2]; indent = ind; out[name] = []; continue; }
    if (name) out[name].push(line);
  }
  return out;
}

function runsOn(lines) {
  const hit = lines.find(l => /^\s*runs-on:/.test(l));
  return hit ? hit.replace(/^\s*runs-on:\s*/, '').trim() : null;
}

// Fails on a GitHub-hosted Windows or macOS image (windows-latest, windows-2022, windows-11-arm, macos-14, ...).
function hostedProblem(value) {
  if (/(^|[\s,[\]'"])(windows|win)-[\w.-]+/i.test(value)) return 'a GitHub-hosted Windows image';
  if (/macos/i.test(value)) return 'a macOS image';
  return null;
}

// The requirement lines of a requirements file, continuation lines joined.
function requirementLines(text) {
  const joined = text.replace(/\\\r?\n/g, ' ');
  return joined.split(/\r?\n/).map(l => l.replace(/(^|\s)#.*$/, '').trim()).filter(l => l && !l.startsWith('-'));
}

function boxProblems(text) {
  const problems = [];
  const all = jobs(text);
  for (const [name, lines] of Object.entries(all)) {
    const r = runsOn(lines);
    const bad = r && hostedProblem(r);
    if (bad) problems.push(`${name} runs on ${bad}: ${r}`);
    // a matrix that feeds runs-on: `os: [...]`, `- os: ...` or a bare list item
    for (const l of lines) if (/^\s*(-\s+)?os:/.test(l) || /^\s*-\s+[\w.-]+\s*$/.test(l)) {
      const b = hostedProblem(l);
      if (b) problems.push(`${name} names ${b}: ${l.trim()}`);
    }
  }
  const box = all['unit-windows'];
  if (!box) { problems.push('no job named unit-windows (nt8/update-pc.ps1 waits for exactly that name)'); return problems; }
  if (runsOn(box) !== BOX_RUNNER) problems.push(`unit-windows runs on ${runsOn(box)}, not ${BOX_RUNNER}`);
  for (const l of box) {
    if (/\bnpm\s+(install|i|add)\b/.test(l)) problems.push(`unit-windows runs an npm install: ${l.trim()}`);
    if (/\bnpm\s+ci\b/.test(l) && !/--ignore-scripts\b/.test(l)) problems.push(`unit-windows runs npm ci without --ignore-scripts: ${l.trim()}`);
    if (/\bpip\s+install\b/.test(l) && !(/--require-hashes\b/.test(l) && /--only-binary\s+:all:/.test(l))) {
      problems.push(`unit-windows runs pip install without --require-hashes and --only-binary :all:: ${l.trim()}`);
    }
  }
  return problems;
}

function reqProblems(text) {
  return requirementLines(text).filter(l => !/--hash=sha256:[0-9a-f]{64}\b/.test(l)).map(l => `no --hash=sha256: on ${l}`);
}

test('ci-workflow: the Windows gate runs on HOMESERVER as unit-windows, no hosted Windows or macOS, nothing unhashed (rules 6.1, 8.7)', () => {
  const problems = boxProblems(fs.readFileSync(WORKFLOW, 'utf8'));
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('ci-workflow: unit-windows installs requirements-box-ci.txt, and every line of it has a sha256 hash', () => {
  const box = jobs(fs.readFileSync(WORKFLOW, 'utf8'))['unit-windows'];
  assert.ok(box.some(l => /pip install .*-r requirements-box-ci\.txt/.test(l)), 'the box job installs from requirements-box-ci.txt');
  const text = fs.readFileSync(BOX_REQS, 'utf8');
  assert.ok(requirementLines(text).length > 0, 'requirements-box-ci.txt names a package');
  const problems = reqProblems(text);
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('ci-workflow: the Linux job runs on pull requests only, the box job on main and non-draft pull requests into main', () => {
  const all = jobs(fs.readFileSync(WORKFLOW, 'utf8'));
  assert.ok(all['unit-linux'], 'a unit-linux job');
  assert.ok(all['unit-linux'].some(l => /^\s*if:.*github\.event_name == 'pull_request'/.test(l)), 'unit-linux: pull requests only');
  assert.equal(runsOn(all['unit-linux']), 'ubuntu-latest');
  assert.ok(all['unit-windows'].some(l => /^\s*if:\s*github\.event_name == 'push' \|\| \(github\.base_ref == 'main' && github\.event\.pull_request\.draft == false\)$/.test(l)),
    'unit-windows: pushes to main and pull requests into main that are not drafts');
});

test('ci-workflow: the guard itself catches what it should (made-up workflows)', () => {
  const ok = fs.readFileSync(WORKFLOW, 'utf8');
  assert.deepEqual(boxProblems(ok), []);
  const cases = [
    ['a hosted Windows matrix', ok.replace('runs-on: ubuntu-latest', 'runs-on: windows-latest')],
    ['a dated Windows image', ok.replace('runs-on: ubuntu-latest', 'runs-on: windows-2022')],
    ['macOS', ok.replace('runs-on: ubuntu-latest', 'runs-on: macos-14')],
    ['a matrix list', ok.replace('runs-on: ubuntu-latest', 'strategy:\n      matrix:\n        os: [ubuntu-latest, windows-latest]\n    runs-on: ${{ matrix.os }}')],
    ['the box job renamed', ok.replace(/^  unit-windows:$/m, '  windows:')],
    ['the box job on another runner', ok.replace(`runs-on: ${BOX_RUNNER}`, 'runs-on: [self-hosted, Windows]')],
    ['npm install on the box', ok.replace('        run: npm test\n      # setup-python', '        run: npm install --no-package-lock\n      # setup-python')],
    ['npm ci without --ignore-scripts', ok.replace('        run: npm test\n      # setup-python', '        run: npm ci\n      # setup-python')],
    ['pip without hashes', ok.replace('--require-hashes --only-binary :all: --target', '--target')],
  ];
  for (const [what, text] of cases) {
    assert.notEqual(text, ok, `${what}: the made-up change applied`);
    assert.ok(boxProblems(text).length > 0, `${what}: caught`);
  }
  assert.deepEqual(boxProblems(ok.replace('        run: npm test\n      # setup-python', '        run: npm ci --ignore-scripts\n      # setup-python')), [],
    'npm ci --ignore-scripts is allowed by rule 8.7 (this repo uses none)');
  assert.ok(reqProblems('numpy==2.5.4\n').length === 1, 'a requirement without a hash is caught');
  assert.ok(reqProblems('numpy==2.5.4 \\\n    --hash=sha256:' + 'a'.repeat(64) + '\n').length === 0, 'a hash on a continuation line counts');
});
