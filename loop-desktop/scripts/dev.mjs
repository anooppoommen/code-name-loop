import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const electronBin = path.join(
  process.cwd(),
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron.cmd' : 'electron',
);

const devHost = process.env.VITE_DEV_HOST ?? '127.0.0.1';
const preferredPort = parseInt(process.env.VITE_DEV_PORT ?? '5173', 10);
const port = await findAvailablePort(Number.isNaN(preferredPort) ? 5173 : preferredPort, 40);
const serverURL = `http://${devHost}:${port}`;
const sharedEnv = {
  ...process.env,
  VITE_DEV_HOST: devHost,
  VITE_DEV_PORT: String(port),
  VITE_DEV_SERVER_URL: serverURL,
};

console.log(`[dev] using Vite port ${port}`);

let shuttingDown = false;
let webProcess = null;
let electronProcess = null;

webProcess = spawn(
  npmCmd,
  ['run', 'dev:web', '--', '--strictPort', '--host', devHost, '--port', String(port)],
  { stdio: 'inherit', env: sharedEnv },
);

webProcess.on('exit', (code, signal) => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  if (electronProcess && !electronProcess.killed) {
    electronProcess.kill('SIGTERM');
  }
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

await waitForPort(port, devHost, 30000).catch((err) => {
  shutdownWithError(`timed out waiting for Vite on ${port}: ${err instanceof Error ? err.message : String(err)}`);
});

electronProcess = spawn(electronBin, ['electron/main.cjs'], {
  stdio: 'inherit',
  env: sharedEnv,
});

electronProcess.on('exit', (code, signal) => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  if (webProcess && !webProcess.killed) {
    webProcess.kill('SIGTERM');
  }
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

for (const eventName of ['SIGINT', 'SIGTERM']) {
  process.on(eventName, () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    if (electronProcess && !electronProcess.killed) {
      electronProcess.kill('SIGTERM');
    }
    if (webProcess && !webProcess.killed) {
      webProcess.kill('SIGTERM');
    }
    process.exit(0);
  });
}

function shutdownWithError(message) {
  console.error(`[dev] ${message}`);
  if (webProcess && !webProcess.killed) {
    webProcess.kill('SIGTERM');
  }
  if (electronProcess && !electronProcess.killed) {
    electronProcess.kill('SIGTERM');
  }
  process.exit(1);
}

async function findAvailablePort(startPort, attempts) {
  for (let i = 0; i < attempts; i += 1) {
    const candidate = startPort + i;
    if (await isPortAvailable(candidate)) {
      return candidate;
    }
  }
  throw new Error(`no available port in range ${startPort}-${startPort + attempts - 1}`);
}

function isPortAvailable(portToCheck) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on('error', () => resolve(false));
    server.listen(portToCheck, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

function waitForPort(portToWait, hostToWait, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.createConnection({ port: portToWait, host: hostToWait });
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - started >= timeoutMs) {
          reject(new Error('timeout'));
          return;
        }
        setTimeout(attempt, 120);
      });
    };
    attempt();
  });
}
