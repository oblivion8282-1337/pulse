/**
 * Tests for health.ts + process.ts — Node built-in test runner.
 *
 * TDD: Tests were written BEFORE implementation (RED → GREEN).
 *
 * Strategy: spawn a real tiny HTTP server as the supervised process
 * (`node -e "require('http').createServer((_,r)=>r.end('ok')).listen(PORT)"`)
 * so no mocking of child_process is needed. The health check uses
 * httpHealth() against that server.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { tcpProbe, httpHealth, waitFor } from '../../electron/localBackend/health.ts';
import { SupervisedProcess } from '../../electron/localBackend/process.ts';

// ---------------------------------------------------------------------------
// Helper: pick a free port by binding then immediately closing
// ---------------------------------------------------------------------------
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

// ---------------------------------------------------------------------------
// tcpProbe unit tests
// ---------------------------------------------------------------------------
describe('tcpProbe', () => {
  test('returns false when nothing is listening', async () => {
    const port = await getFreePort();
    const result = await tcpProbe(port, '127.0.0.1', 300);
    assert.equal(result, false);
  });

  test('returns true when a server is listening', async () => {
    const port = await getFreePort();
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(port, '127.0.0.1', r));
    try {
      const result = await tcpProbe(port, '127.0.0.1', 500);
      assert.equal(result, true);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});

// ---------------------------------------------------------------------------
// httpHealth unit tests
// ---------------------------------------------------------------------------
describe('httpHealth', () => {
  test('returns false when nothing is listening', async () => {
    const port = await getFreePort();
    const result = await httpHealth(`http://127.0.0.1:${port}/`, 300);
    assert.equal(result, false);
  });

  test('returns true when server responds 200', async () => {
    const port = await getFreePort();
    const srv = createServer((_, res) => { res.writeHead(200); res.end('ok'); });
    await new Promise<void>((r) => srv.listen(port, '127.0.0.1', r));
    try {
      const result = await httpHealth(`http://127.0.0.1:${port}/`, 500);
      assert.equal(result, true);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  test('returns false when server responds 500', async () => {
    const port = await getFreePort();
    const srv = createServer((_, res) => { res.writeHead(500); res.end('err'); });
    await new Promise<void>((r) => srv.listen(port, '127.0.0.1', r));
    try {
      const result = await httpHealth(`http://127.0.0.1:${port}/`, 500);
      assert.equal(result, false);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});

// ---------------------------------------------------------------------------
// waitFor unit tests
// ---------------------------------------------------------------------------
describe('waitFor', () => {
  test('resolves immediately when check returns true on first call', async () => {
    let calls = 0;
    await waitFor(async () => { calls++; return true; }, 1000);
    assert.equal(calls, 1);
  });

  test('resolves after check eventually returns true', async () => {
    let calls = 0;
    await waitFor(async () => { calls++; return calls >= 3; }, 2000, 50);
    assert.ok(calls >= 3);
  });

  test('throws on timeout when check never returns true', async () => {
    await assert.rejects(
      () => waitFor(async () => false, 300, 50),
      /timed out/i,
    );
  });
});

// ---------------------------------------------------------------------------
// SupervisedProcess integration tests
// ---------------------------------------------------------------------------
describe('SupervisedProcess', () => {
  test('start() resolves only after httpHealth passes (health-gate)', async () => {
    const port = await getFreePort();
    const healthUrl = `http://127.0.0.1:${port}/`;

    const proc = new SupervisedProcess({
      name: 'test-http',
      command: process.execPath,
      args: [
        '-e',
        `require('http').createServer((_,r)=>{r.writeHead(200);r.end('ok')}).listen(${port},'127.0.0.1')`,
      ],
      env: {},
      healthCheck: () => httpHealth(healthUrl, 300),
      restartMax: 0,
      gracePeriodMs: 500,
    });

    // Before start(), health check must fail.
    const beforeStart = await httpHealth(healthUrl, 200);
    assert.equal(beforeStart, false);

    await proc.start();

    // After start() resolves, health must pass.
    const afterStart = await httpHealth(healthUrl, 500);
    assert.equal(afterStart, true);

    await proc.stop();
  });

  test('stop() terminates the process — tcpProbe becomes false', async () => {
    const port = await getFreePort();

    const proc = new SupervisedProcess({
      name: 'test-stop',
      command: process.execPath,
      args: [
        '-e',
        `require('http').createServer((_,r)=>{r.writeHead(200);r.end('ok')}).listen(${port},'127.0.0.1')`,
      ],
      env: {},
      healthCheck: () => httpHealth(`http://127.0.0.1:${port}/`, 300),
      restartMax: 0,
      gracePeriodMs: 500,
    });

    await proc.start();
    assert.equal(await tcpProbe(port, '127.0.0.1', 500), true);

    await proc.stop();

    // Give the OS a moment to release the port.
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await tcpProbe(port, '127.0.0.1', 300), false);
  });

  test('restart: killing child externally triggers restart up to restartMax times', async () => {
    const port = await getFreePort();
    let exitEvents = 0;

    const proc = new SupervisedProcess({
      name: 'test-restart',
      command: process.execPath,
      args: [
        '-e',
        `require('http').createServer((_,r)=>{r.writeHead(200);r.end('ok')}).listen(${port},'127.0.0.1')`,
      ],
      env: {},
      healthCheck: () => httpHealth(`http://127.0.0.1:${port}/`, 400),
      restartMax: 2,
      gracePeriodMs: 500,
    });

    proc.onExit((code) => { exitEvents++; });

    await proc.start();

    // Kill the child externally — it should restart.
    proc.killForTest();
    // Wait for restart to complete (up to 5s).
    await waitFor(() => httpHealth(`http://127.0.0.1:${port}/`, 300), 5000, 200);

    // Kill a second time — should restart again.
    proc.killForTest();
    await waitFor(() => httpHealth(`http://127.0.0.1:${port}/`, 300), 5000, 200);

    assert.ok(exitEvents >= 2, `expected >=2 exit events, got ${exitEvents}`);

    await proc.stop();
  });

  test('onExit callback is called when process exits via stop()', async () => {
    const port = await getFreePort();
    let exitCode: number | null | undefined = undefined;

    const proc = new SupervisedProcess({
      name: 'test-exit-cb',
      command: process.execPath,
      args: [
        '-e',
        `require('http').createServer((_,r)=>{r.writeHead(200);r.end('ok')}).listen(${port},'127.0.0.1')`,
      ],
      env: {},
      healthCheck: () => httpHealth(`http://127.0.0.1:${port}/`, 300),
      restartMax: 0,
      gracePeriodMs: 500,
    });

    proc.onExit((code) => { exitCode = code; });

    await proc.start();
    await proc.stop();

    // After stop, give the callback a moment to fire.
    await new Promise((r) => setTimeout(r, 300));
    assert.notEqual(exitCode, undefined, 'onExit callback was not called');
  });
});
