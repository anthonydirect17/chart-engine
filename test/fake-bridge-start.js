'use strict';
// Starts test/fake-bridge.mjs for a test on 127.0.0.1 port 0 (SERVER_RULES.md rule 6.5: a test server binds port 0,
// never a chosen port) and learns the port the system picked from the bridge's ready line on stdout
// ("fake ChartBridge on http://localhost:<port>/live/ ..."). A helper, not a test file (npm test runs test/*.test.js).
//   const { child, port } = await startFakeBridge(['--v3', '--trading']);   ...   child.kill();
const path = require('node:path');
const { spawn } = require('node:child_process');

const READY = /fake ChartBridge on http:\/\/localhost:(\d+)\/live\//;

function startFakeBridge(flags) {
  const child = spawn(process.execPath, [path.join(__dirname, 'fake-bridge.mjs'), '0'].concat(flags || []), { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    let seen = '';
    const done = () => { child.stdout.off('data', onData); child.off('exit', onExit); child.off('error', onError); };
    const onData = d => {
      seen += d;
      const m = READY.exec(seen);
      if (m && +m[1] > 0) { done(); child.stdout.resume(); resolve({ child, port: +m[1] }); }
    };
    const onExit = code => { done(); reject(new Error('fake-bridge.mjs ended before its ready line (exit ' + code + '): ' + seen)); };
    const onError = e => { done(); reject(e); };
    child.stdout.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

module.exports = { startFakeBridge, READY };
