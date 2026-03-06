import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTunnel, destroyTunnel, getTunnelStatus } from '../electron/ssh-tunnel.cjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');
const KEYS_DIR = path.join(ROOT_DIR, '.run', 'test-keys');
const PRIVATE_KEY_PATH = path.join(KEYS_DIR, 'test_rsa');

test('SSH Tunnel E2E Flow', async (t) => {
    // 1. Generate keys
    execSync('bash scripts/setup-test-keys.sh', { cwd: ROOT_DIR, stdio: 'inherit' });

    // 2. Start Docker container
    console.log('Starting Docker container...');
    execSync('docker compose -f docker-compose.test.yml up -d --build --wait', { cwd: ROOT_DIR, stdio: 'inherit' });

    // 3. Wait for health check (loop API server inside container)
    console.log('Waiting for Loop API to be healthy via local ssh proxy check inside container...');
    let healthy = false;
    for (let i = 0; i < 30; i++) {
        try {
            execSync('docker compose -f docker-compose.test.yml exec loop-server curl -sf http://localhost:8080/health', { cwd: ROOT_DIR });
            healthy = true;
            break;
        } catch {
            await new Promise(r => setTimeout(r, 1000));
        }
    }
    assert.ok(healthy, 'Loop server inside Docker never became healthy');
    console.log('Container healthy!');

    // Cleanup block at end of test
    t.after(() => {
        console.log('Tearing down tunnel and Docker container...');
        destroyTunnel();
        execSync('docker compose -f docker-compose.test.yml down -v', { cwd: ROOT_DIR, stdio: 'inherit' });
    });

    let localPort;

    await t.test('Connect to SSH tunnel', async () => {
        const res = await createTunnel({
            host: 'localhost',
            port: 2222,
            username: 'root',
            privateKeyPath: PRIVATE_KEY_PATH,
            remotePort: 8080
        });

        assert.strictEqual(res.ok, true, 'Tunnel connection should succeed');
        assert.ok(res.localPort > 0, 'Should assign a valid local port');
        localPort = res.localPort;

        const status = getTunnelStatus();
        assert.strictEqual(status.status, 'connected');
        assert.strictEqual(status.localPort, localPort);
    });

    await t.test('Hit API through SSH tunnel', async () => {
        const url = `http://localhost:${localPort}/health`;
        const response = await fetch(url);
        assert.strictEqual(response.ok, true, 'Health check should return 200 OK');

        const body = await response.json();
        assert.strictEqual(body.status, 'healthy');
    });

    let workspaceId;
    let convId;

    await t.test('Create workspace & conversation via tunnel', async () => {
        workspaceId = `ws-${Date.now()}`;
        const wsRes = await fetch(`http://localhost:${localPort}/workspaces`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ID: workspaceId,
                Name: 'Test Workspace',
                RootPath: '/tmp',
                CanonicalRootPath: '/tmp'
            })
        });
        assert.strictEqual(wsRes.ok, true, 'Create workspace should succeed');

        convId = `conv-${Date.now()}`;
        const cvRes = await fetch(`http://localhost:${localPort}/conversations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ID: convId,
                WorkspaceID: workspaceId,
                Title: 'Test Conv'
            })
        });
        assert.strictEqual(cvRes.ok, true, 'Create conversation should succeed');
    });

    await t.test('Disconnect tunnel', async () => {
        await destroyTunnel();
        const status = getTunnelStatus();
        assert.strictEqual(status.status, 'disconnected');
        assert.strictEqual(status.localPort, null);

        // Verify it's actually down
        try {
            await fetch(`http://localhost:${localPort}/health`);
            assert.fail('Fetch should have thrown after tunnel disconnected');
        } catch (err) {
            // expected to fail
        }
    });

    await t.test('Reconnect tunnel and retrieve state', async () => {
        const res = await createTunnel({
            host: 'localhost',
            port: 2222,
            username: 'root',
            privateKeyPath: PRIVATE_KEY_PATH,
            remotePort: 8080
        });
        assert.strictEqual(res.ok, true, 'Tunnel reconnection should succeed');
        localPort = res.localPort;

        const listRes = await fetch(`http://localhost:${localPort}/workspaces/${workspaceId}/conversations`);
        assert.strictEqual(listRes.ok, true);

        const body = await listRes.json();
        console.dir(body, { depth: null });
        assert.ok(Array.isArray(body.conversations), 'Should return conversations array');
        assert.ok(body.conversations.find((c) => c.id === convId || c.ID === convId), 'Should find the conversation we created before disconnect');
    });

});
