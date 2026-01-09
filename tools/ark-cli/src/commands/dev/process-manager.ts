import {execa, type ResultPromise} from 'execa';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type {DevService, ServiceStatus} from './types.js';

const STATE_FILE = path.join(os.homedir(), '.ark', 'dev-state.json');

const COMMON_PATHS = [
  '/opt/homebrew/bin',
  '/usr/local/go/bin',
  '/usr/local/bin',
  '/usr/bin',
  process.env.GOROOT ? `${process.env.GOROOT}/bin` : '',
  process.env.GOPATH ? `${process.env.GOPATH}/bin` : '',
].filter(Boolean);

function getEnhancedPath(): string {
  const currentPath = process.env.PATH || '';
  const pathParts = currentPath.split(':');
  for (const p of COMMON_PATHS) {
    if (!pathParts.includes(p)) {
      pathParts.unshift(p);
    }
  }
  return pathParts.join(':');
}

interface ProcessState {
  pid: number;
  name: string;
  port: number;
  startedAt: string;
}

export class DevProcessManager {
  private processes: Map<string, ResultPromise> = new Map();
  private logStreams: Map<string, fs.WriteStream> = new Map();

  async startService(service: DevService, onLog?: (name: string, data: string) => void): Promise<void> {
    const logDir = path.join(os.homedir(), '.ark', 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, {recursive: true});
    }

    const logFile = path.join(logDir, `${service.name}.log`);
    const logStream = fs.createWriteStream(logFile, {flags: 'a'});
    this.logStreams.set(service.name, logStream);

    const proc = execa(service.command, service.args, {
      cwd: service.cwd,
      env: {...process.env, PATH: getEnhancedPath(), ...service.env},
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    proc.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      logStream.write(`[stdout] ${text}`);
      onLog?.(service.name, text);
    });

    proc.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      logStream.write(`[stderr] ${text}`);
      onLog?.(service.name, text);
    });

    proc.on('exit', (code) => {
      logStream.write(`[exit] Process exited with code ${code}\n`);
      this.processes.delete(service.name);
    });

    this.processes.set(service.name, proc);
    this.saveState();

    await this.waitForHealth(service);
  }

  async waitForHealth(service: DevService): Promise<void> {
    const timeout = service.startupTimeout || 30000;
    const startTime = Date.now();
    const isHttps = service.healthCheck.startsWith('https');

    while (Date.now() - startTime < timeout) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000);

        if (isHttps) {
          const https = await import('https');
          const url = new URL(service.healthCheck);
          const result = await new Promise<{ok: boolean; status: number}>((resolve, reject) => {
            const req = https.request({
              hostname: url.hostname,
              port: url.port || 443,
              path: url.pathname,
              method: 'GET',
              rejectUnauthorized: false,
              timeout: 2000,
            }, (res) => {
              resolve({ok: res.statusCode !== undefined && res.statusCode < 400, status: res.statusCode || 0});
            });
            req.on('error', reject);
            req.on('timeout', () => reject(new Error('timeout')));
            req.end();
          });

          clearTimeout(timeoutId);

          if (result.ok || result.status < 500) {
            return;
          }
        } else {
          const response = await fetch(service.healthCheck, {signal: controller.signal});
          clearTimeout(timeoutId);

          if (response.ok || response.status < 500) {
            return;
          }
        }
      } catch {
        // Service not ready yet, wait and retry
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    throw new Error(`Service ${service.name} failed to become healthy within ${timeout}ms`);
  }

  async stopService(name: string): Promise<void> {
    const proc = this.processes.get(name);
    if (proc) {
      proc.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          proc.kill('SIGKILL');
          resolve();
        }, 5000);

        proc.on('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      this.processes.delete(name);
    }

    const logStream = this.logStreams.get(name);
    if (logStream) {
      logStream.end();
      this.logStreams.delete(name);
    }

    this.saveState();
  }

  async stopAll(): Promise<void> {
    const names = Array.from(this.processes.keys()).reverse();
    for (const name of names) {
      await this.stopService(name);
    }
    this.clearState();
  }

  getRunningServices(): string[] {
    return Array.from(this.processes.keys());
  }

  isRunning(name: string): boolean {
    return this.processes.has(name);
  }

  getPid(name: string): number | undefined {
    return this.processes.get(name)?.pid;
  }

  private saveState(): void {
    const stateDir = path.dirname(STATE_FILE);
    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, {recursive: true});
    }

    const state: ProcessState[] = [];
    for (const [name, proc] of this.processes) {
      if (proc.pid) {
        state.push({
          name,
          pid: proc.pid,
          port: 0,
          startedAt: new Date().toISOString(),
        });
      }
    }

    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  }

  private clearState(): void {
    if (fs.existsSync(STATE_FILE)) {
      fs.unlinkSync(STATE_FILE);
    }
  }

  static loadState(): ProcessState[] {
    if (fs.existsSync(STATE_FILE)) {
      try {
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      } catch {
        return [];
      }
    }
    return [];
  }

  static isProcessRunning(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  static killProcess(pid: number): void {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Process might already be dead
    }
  }
}
