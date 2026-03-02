const { Client } = require('ssh2');
const net = require('node:net');
const fs = require('node:fs');
const EventEmitter = require('node:events');

let tunnelClient = null;
let tunnelServer = null;
let currentLocalPort = null;
let tunnelStatus = 'disconnected'; // disconnected, connecting, connected, error
let lastError = null;

const tunnelEvents = new EventEmitter();

function getTunnelStatus() {
    return {
        status: tunnelStatus,
        localPort: currentLocalPort,
        error: lastError,
    };
}

function updateStatus(newStatus, errorMsg = null) {
    tunnelStatus = newStatus;
    lastError = errorMsg;
    tunnelEvents.emit('status-change', getTunnelStatus());
}

async function destroyTunnel() {
    if (tunnelServer) {
        tunnelServer.close();
        tunnelServer = null;
    }
    if (tunnelClient) {
        tunnelClient.end();
        tunnelClient = null;
    }
    currentLocalPort = null;
    if (tunnelStatus !== 'disconnected') {
        updateStatus('disconnected');
    }
}

/**
 * config: { host, port, username, privateKeyPath, remotePort }
 */
async function createTunnel(config) {
    // Tear down existing tunnel first
    await destroyTunnel();

    updateStatus('connecting');

    return new Promise((resolve) => {
        let privateKey;
        try {
            privateKey = fs.readFileSync(config.privateKeyPath);
        } catch (err) {
            updateStatus('error', `Failed to read private key: ${err.message}`);
            return resolve({ ok: false, error: err.message });
        }

        const client = new Client();
        tunnelClient = client;

        client.on('ready', () => {
            // SSH connection established, now create local forwarding server
            const server = net.createServer((socket) => {
                client.forwardOut(
                    '127.0.0.1',
                    socket.remotePort,
                    '127.0.0.1',
                    config.remotePort || 8080,
                    (err, stream) => {
                        if (err) {
                            console.error(`[ssh-tunnel] forwardOut error: ${err.message}`);
                            socket.end();
                            return;
                        }
                        socket.pipe(stream);
                        stream.pipe(socket);
                    }
                );
            });

            tunnelServer = server;

            server.on('error', (err) => {
                console.error(`[ssh-tunnel] local server error: ${err.message}`);
                updateStatus('error', `Local server error: ${err.message}`);
                destroyTunnel();
            });

            // Let OS pick a free port
            server.listen(0, '127.0.0.1', () => {
                currentLocalPort = server.address().port;
                updateStatus('connected');
                resolve({ ok: true, localPort: currentLocalPort });
            });
        });

        client.on('error', (err) => {
            console.error(`[ssh-tunnel] client error: ${err.message}`);
            updateStatus('error', err.message);

            // If we haven't resolved the initial connect yet, resolve with error
            if (tunnelStatus === 'connecting' || tunnelStatus === 'error') {
                resolve({ ok: false, error: err.message });
            }
            destroyTunnel();
        });

        client.on('end', () => {
            console.log('[ssh-tunnel] client ended');
            destroyTunnel();
        });

        client.on('close', () => {
            console.log('[ssh-tunnel] client closed');
            destroyTunnel();
        });

        // Start connection
        try {
            client.connect({
                host: config.host,
                port: config.port || 22,
                username: config.username,
                privateKey: privateKey,
                readyTimeout: 10000, // 10s timeout
            });
        } catch (err) {
            updateStatus('error', `Client connect failed: ${err.message}`);
            resolve({ ok: false, error: err.message });
        }
    });
}

module.exports = {
    createTunnel,
    destroyTunnel,
    getTunnelStatus,
    tunnelEvents,
};
