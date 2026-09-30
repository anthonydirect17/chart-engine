// The per-PC updater (nt8/update-pc.ps1): the rules its files must keep, and its PowerShell tests
// (test/pc-updater.tests.ps1), run here with Windows PowerShell 5.1 on Windows (as on the trading PCs) or pwsh
// elsewhere; skipped when neither is installed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const manifest = JSON.parse(read('nt8/install-files.json'));
const compat = JSON.parse(read('live/COMPAT.json'));
const updater = read('nt8/update-pc.ps1');
const install = read('nt8/install.ps1');
const cbVersion = /public const string Version = "([^"]+)"/.exec(read('nt8/ChartBridge.cs'))[1];
const ver = v => v.split('.').map(Number);
const cmp = (a, b) => { const x = ver(a), y = ver(b); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); } return 0; };
// code only: PowerShell comment blocks and line comments may name the rules they keep
const code = text => text.replace(/<#[\s\S]*?#>/g, m => '\n'.repeat(m.split('\n').length - 1)).split('\n').map(l => l.replace(/(^|\s)#.*$/, '')).join('\n');

test('install-files.json: one list, every file there, the add-ons are exactly nt8/*.cs', () => {
  for (const f of manifest.www) assert.ok(fs.existsSync(path.join(root, f.from)), f.from);
  for (const f of manifest.addons) assert.ok(fs.existsSync(path.join(root, f)), f);
  const cs = fs.readdirSync(path.join(root, 'nt8')).filter(f => f.endsWith('.cs')).map(f => 'nt8/' + f).sort();
  assert.deepStrictEqual([...manifest.addons].sort(), cs);
  const to = manifest.www.map(f => f.to);
  assert.strictEqual(new Set(to).size, to.length, 'no target twice');
  assert.ok(to.includes('update-notice.js') && to.includes('index.html') && to.includes('src/chart-engine.js'));
  assert.ok(!to.includes('update.json'), 'update.json is the updater\'s own file');
  assert.ok(manifest.www.every(f => !f.to.endsWith('.cs') && !f.from.endsWith('.cs')), 'no .cs file goes to www');
  // every page file index.html loads is installed
  for (const src of read('live/index.html').match(/<(?:script|link)[^>]+(?:src|href)="([^":]+)"/g).map(t => /(?:src|href)="([^"]+)"/.exec(t)[1])) {
    const target = src.replace(/^\.\.\//, '');
    assert.ok(to.includes(target), 'index.html loads ' + src + ', which is not installed');
  }
});

test('install.ps1 and update-pc.ps1 read that list; install.ps1 names no file itself', () => {
  assert.match(install, /install-files\.json/);
  assert.match(updater, /\$script:ManifestPath = 'nt8\/install-files\.json'/);
  for (const f of manifest.www.concat(manifest.addons.map(a => ({ from: a })))) {
    assert.ok(!code(install).includes(path.basename(f.from)), 'install.ps1 names ' + f.from);
    // the updater names only the files it orders (Get-PageOrder) and the one it reads the version from
    const named = ['nt8/ChartBridge.cs', 'live/index.html', 'live/live.js', 'live/update-notice.js'];
    assert.ok(!code(updater).includes(path.basename(f.from)) || named.includes(f.from), 'update-pc.ps1 names ' + f.from);
  }
});

test('COMPAT.json follows package.json and the ChartBridge in this commit', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.strictEqual(compat.page, pkg.version, 'COMPAT.json page = package.json version');
  assert.match(compat.minChartBridge, /^\d+\.\d+\.\d+$/);
  assert.ok(cmp(compat.minChartBridge, cbVersion) <= 0, `the page needs ChartBridge ${compat.minChartBridge}, newer than this commit's ${cbVersion}`);
  assert.deepStrictEqual({ page: compat.history[0].page, minChartBridge: compat.history[0].minChartBridge }, { page: compat.page, minChartBridge: compat.minChartBridge }, 'history starts with the current line');
});

test('the automatic path never copies add-on files: only -InstallChartBridge, after Anthony confirms', () => {
  const src = code(updater);
  const calls = [...src.matchAll(/Install-AddOnFiles\s+\$/g)];
  assert.strictEqual(calls.length, 1, 'one call');
  const fnStart = src.lastIndexOf('function ', calls[0].index);
  assert.match(src.slice(fnStart, fnStart + 40), /^function Invoke-InstallChartBridge/);
  const allow = [...src.matchAll(/\$script:AddOnWriteAllowed = \$true/g)];
  assert.strictEqual(allow.length, 1);
  assert.match(src.slice(src.lastIndexOf('function ', allow[0].index), src.lastIndexOf('function ', allow[0].index) + 40), /^function Invoke-InstallChartBridge/);
  const body = src.slice(src.indexOf('function Invoke-InstallChartBridge'), src.indexOf('function Invoke-Repair'));
  assert.ok(body.indexOf('Read-Host') < body.indexOf('$script:AddOnWriteAllowed = $true'), 'asks first (unless -Yes)');
  assert.match(src, /function Install-AddOnFiles[\s\S]{0,80}if \(-not \$script:AddOnWriteAllowed\) \{ throw/);
  // the only place anything is written under AddOns is Install-AddOnFiles; Get-AddOnVersion only reads
  const fnOf = i => src.slice(src.lastIndexOf('function ', i), src.lastIndexOf('function ', i) + 40).split(/[\s(]/)[1];
  const uses = [...src.matchAll(/\$script:P\.AddOns/g)].map(m => fnOf(m.index));
  assert.deepStrictEqual([...new Set(uses)].sort(), ['Get-AddOnHashes', 'Get-AddOnVersion', 'Install-AddOnFiles', 'Invoke-InstallChartBridge'].sort());
  const reader = src.slice(src.indexOf('function Get-AddOnVersion'), src.indexOf('function Get-LowerVersion'));
  assert.ok(!/Copy-Item|Move-|Write|Set-Content|Remove-Item|Replace\(/.test(reader), 'Get-AddOnVersion only reads');
  const hashes = src.slice(src.indexOf('function Get-AddOnHashes'), src.indexOf('function Test-SameHashes'));
  assert.ok(hashes.length > 0 && !/Copy-Item|Move-|Write|Set-Content|Remove-Item|Replace\(/.test(hashes), 'Get-AddOnHashes only reads');
  // all or nothing: a failed replace puts back every file already replaced, and a mix is never left unsaid
  const copy = src.slice(src.indexOf('function Install-AddOnFiles'), src.indexOf('function Update-MixedAddOns'));
  assert.match(copy, /\$State\['chartBridge'\]\['copying'\] = [\s\S]*Save-State \$State[\s\S]*foreach \(\$n in \$names\) \{\s*Move-FileAtomic/, 'the copy is recorded before the first replace');
  assert.match(copy, /\} catch \{[\s\S]*foreach \(\$n in @\(\$replaced\)\)[\s\S]*Move-FileAtomic "\$dest\.upd-restore" \$dest/, 'a failure puts the replaced files back');
  const inst = src.slice(src.indexOf('function Invoke-InstallChartBridge'), src.indexOf('function Invoke-Repair'));
  assert.ok(!/Copy-Item|Move-FileAtomic/.test(inst.replace(/Install-AddOnFiles|Install-PinnedUpdater|Install-PageFiles/g, '')), '-InstallChartBridge writes AddOns only through Install-AddOnFiles');
});

test('no PowerShell command strings (Norton on WORK blocks -EncodedCommand): scripts run with -File', () => {
  const flag = /(^|\s)[-/](ec|e|en|enc|enco|encod|encode|encoded|encodedc\w*|c|co|com|comm|comma|comman|command)(\s|$)/i;
  for (const f of ['nt8/update-pc.ps1', 'nt8/install.ps1', 'test/pc-updater.tests.ps1']) {
    const text = code(read(f));
    text.split('\n').forEach((line, i) => {
      if (/powershell|pwsh|-ExecutionPolicy|-NoProfile/i.test(line)) assert.ok(!flag.test(line.replace(/['"(),@]/g, ' ')), `${f}:${i + 1}: ${line.trim()}`);
    });
    assert.ok(!/Invoke-Expression|\biex\b|EncodedCommand|FromBase64String|ToBase64String/i.test(text), f + ' builds or runs a command string');
  }
  assert.match(updater, /'-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File ' \+ \(Format-Arg \$Script\) \+ ' update -Repo ' \+ \(Format-Arg \$RepoDir\)/);
});

test('the automatic path never moves Anthony\'s clone, and git never asks anything', () => {
  const src = code(updater);
  // one entry point with a runtime allow-list of subcommands that only read or fetch into refs/remotes
  const allowed = eval('[' + /\$script:GitAllowed = @\(([^)]*)\)/.exec(src)[1] + ']');
  assert.deepStrictEqual([...allowed].sort(), ['archive', 'cat-file', 'fetch', 'hash-object', 'ls-tree', 'merge-base', 'remote', 'rev-list', 'rev-parse', 'show', 'symbolic-ref'].sort());
  assert.match(src, /\$refused = Test-GitArgs \$ArgList\s+if \(\$refused\) \{ throw \$refused \}/);
  assert.match(src, /if \(\$script:GitAllowed -notcontains \$sub\) \{ return/);
  // the three subcommands with a writing form are checked in full
  for (const sub of ['symbolic-ref', 'remote', 'hash-object']) assert.match(src, new RegExp("if \\(\\$sub -eq '" + sub + "'\\) \\{"), sub);
  // every call, written @( or (@(, starts with a literal subcommand from that list; git runs nowhere else
  const calls = [...src.matchAll(/Invoke-Git\s+\(?@\(\s*([^,)]+)/g)].map(m => m[1].trim());
  assert.ok(calls.length >= 12, calls.join(','));
  for (const c of calls) assert.ok(/^'[a-z-]+'$/.test(c) && allowed.includes(c.slice(1, -1)), 'Invoke-Git ' + c);
  assert.strictEqual([...src.matchAll(/Invoke-Git\b/g)].length, calls.length + 1, 'no Invoke-Git call built from a variable');
  assert.strictEqual([...src.matchAll(/Invoke-Native \$git\b/g)].length, 1, 'git runs only through Invoke-Git');
  for (const v of ["'GIT_TERMINAL_PROMPT'] = '0'", "'GCM_INTERACTIVE'] = 'never'", "'GIT_ASKPASS'] = ''", "'SSH_ASKPASS'] = ''", "'GIT_SSH_COMMAND'] = 'ssh -o BatchMode=yes'"]) assert.ok(src.includes(v), v);
  assert.match(src, /'-c', 'credential\.interactive=never', '-c', 'core\.sshCommand=ssh -o BatchMode=yes', '-c', 'core\.askPass=',\s*'-c', 'gc\.auto=0', '-c', 'maintenance\.auto=false'/);
  assert.match(src, /-WorkingDirectory \$script:P\.Bin/);
  assert.match(src, /\$src = Get-PinSource \$state/);
});

test('no message sends Anthony to install.ps1 (it copies .cs files without the prompt); recovery is update-pc.ps1 repair', () => {
  const src = code(updater);
  assert.ok(!/install\.ps1/i.test(src), 'update-pc.ps1 names install.ps1 outside comments');
  assert.match(src, /update-pc\.ps1 repair/);
  const readme = read('README.md');
  const section = readme.slice(readme.indexOf('### Keep this PC up to date'), readme.indexOf('## Trading from the chart'));
  assert.ok(!/install\.ps1/.test(section), 'the README section names install.ps1');
});

test('the schedule (Anthony, 2026-09-30): at sign-in and once a day at 17:05 New York time, nothing repeating, no late start', () => {
  const src = code(updater);
  assert.match(src, /\[string\]\$DailyAt = '17:05'/);
  assert.match(src, /New-ScheduledTaskTrigger -AtLogOn -User \$user/);
  assert.match(src, /\$logon\.Delay = 'PT2M'/);
  assert.match(src, /\$daily = New-DailyTrigger \$local/);
  // local wall-clock time with no UTC offset: Task Scheduler then keeps 17:05 on this PC's clock across DST
  assert.match(src, /function New-DailyTrigger[\s\S]{0,120}New-ScheduledTaskTrigger -Daily -At \$Local\s+\$t\.StartBoundary = \$Local\.ToString\('yyyy-MM-ddTHH:mm:ss'/);
  assert.strictEqual([...src.matchAll(/New-ScheduledTaskTrigger -Daily/g)].length, 1, 'every daily trigger is made by New-DailyTrigger');
  assert.match(src, /-Trigger @\(\$logon, \$daily\)/);
  assert.ok(!/RepetitionInterval|StartWhenAvailable|\$Hours/.test(src), 'no repetition, no late start of a missed run');
  assert.match(src, /-MultipleInstances IgnoreNew/);
  assert.match(src, /-ExecutionTimeLimit \(New-TimeSpan -Minutes 30\)/);
});

test('the scripts suit Windows PowerShell 5.1: ASCII only, no PowerShell 7 syntax; no dashes Anthony does not use', () => {
  for (const f of ['nt8/update-pc.ps1', 'nt8/install.ps1', 'test/pc-updater.tests.ps1', 'nt8/install-files.json', 'live/COMPAT.json']) {
    const t = read(f);
    assert.ok(/^[\x00-\x7F]*$/.test(t), f + ' is not ASCII (5.1 reads a file without a BOM as ANSI)');
    assert.ok(!/\?\?|\?\.[A-Za-z]|&&|\|\|/.test(code(t).replace(/'[^']*'|"[^"]*"/g, '')), f + ' uses syntax Windows PowerShell 5.1 lacks');
  }
  for (const f of ['live/update-notice.js', 'test/update-notice-smoke.mjs', 'test/pc-updater.test.js', 'README.md', 'CHANGELOG.md']) {
    assert.ok(!/[\u2013\u2014]/.test(read(f)), f + ' has an en or em dash');
  }
});

test('ChartBridge answers /diag to a program on this PC: no PIN, no Origin, only the loopback check before it', () => {
  const cs = read('nt8/ChartBridge.cs');
  const handle = cs.slice(cs.indexOf('private static async Task Handle('), cs.indexOf('private static IPEndPoint RemoteOf('));
  const diag = handle.indexOf('if (path == "/diag")');
  assert.ok(diag > 0 && handle.indexOf('IsLoopback(remote)') < diag, 'the loopback check comes first');
  assert.match(handle, /if \(path == "\/diag"\) \{ ServeText\(ctx, DiagJson\(\), "application\/json"\); return; \}/);
  assert.match(cs, /b\.Append\("\\"version\\":"\)\.Append\(CbJson\.Str\(Version\)\)/);
  assert.match(updater, /\[System\.Net\.HttpWebRequest\]::Create\(\$url\)/);
  assert.match(updater, /"http:\/\/localhost:\$\(Get-ChartBridgePort\)\/diag"/, 'Host localhost:<port>, as HttpListener\'s prefix wants');
});

test('the page notice never reloads, navigates or sends anything, and only index.html loads it', () => {
  const js = read('live/update-notice.js');
  assert.ok(!/location\.(reload|assign|replace|href\s*=)|window\.open|\.submit\(|WebSocket|method:\s*'POST'/.test(js));
  assert.deepStrictEqual([...js.matchAll(/fetch\(([^,)]+)/g)].map(m => m[1]), ["'update.json'"]);
  assert.match(js, /cache: 'no-store'/);
  const html = read('live/index.html');
  assert.ok(html.indexOf('update-notice.js') > html.indexOf('live.js'), 'after live.js');
  assert.ok(!read('live/live.js').includes('update-notice'), 'a mounted chart (The Desk) does not load it');
});

test('the PowerShell tests (test/pc-updater.tests.ps1)', t => {
  const git = spawnSync('git', ['--version'], { encoding: 'utf8' });
  const ps = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';     // Windows PowerShell 5.1, as on the trading PCs
  if (git.error) { t.skip('no git here'); return; }
  // PowerShell 7's module path (CI's default shell) breaks modules in Windows PowerShell 5.1: start it as a scheduled
  // task does, with its own
  const env = Object.assign({}, process.env);
  if (process.platform === 'win32') delete env.PSModulePath;
  const r = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'test', 'pc-updater.tests.ps1')],
    { encoding: 'utf8', timeout: 600000, maxBuffer: 16 * 1024 * 1024, env });
  if (r.error && r.error.code === 'ENOENT') { t.skip('no ' + ps + ' here'); return; }
  const out = (r.stdout || '') + (r.stderr || '');
  const summary = /pc-updater: (\d+) passed, (\d+) failed, (\d+) skipped/.exec(out);
  t.diagnostic(summary ? summary[0] + ' (' + ps + ')' : 'no summary');
  for (const line of out.split(/\r?\n/).filter(l => /^OK: scheduled task|^pc-updater (dst|xml):/.test(l))) t.diagnostic(line.trim());
  assert.ok(summary, 'the PowerShell tests ran to the end:\n' + out.slice(-4000));
  assert.strictEqual(+summary[2], 0, out.split('\n').filter(l => /FAIL/.test(l)).join('\n'));
  assert.ok(+summary[1] >= 25, 'ran them all');
  assert.strictEqual(r.status, 0, out.slice(-2000));
});
