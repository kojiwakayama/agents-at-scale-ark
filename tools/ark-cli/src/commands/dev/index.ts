import chalk from 'chalk';
import {Command} from 'commander';
import ora from 'ora';
import path from 'path';
import {execa} from 'execa';
import fs from 'fs';
import type {ArkConfig} from '../../lib/config.js';
import {getDevServices} from './services.js';
import {writeDevKubeconfig, getKubeconfigPath, removeDevKubeconfig} from './kubeconfig.js';
import {DevProcessManager} from './process-manager.js';

async function findArkRoot(): Promise<string> {
  let current = process.cwd();

  while (current !== '/') {
    if (
      fs.existsSync(path.join(current, 'services/ark-apiserver')) &&
      fs.existsSync(path.join(current, 'tools/ark-cli'))
    ) {
      return current;
    }
    current = path.dirname(current);
  }

  throw new Error(
    'Could not find Ark repository root. Make sure you are running from within the Ark repository.'
  );
}

async function checkCommand(cmd: string, name: string): Promise<{version: string; ok: boolean}> {
  try {
    const {stdout} = await execa(cmd, ['--version']);
    const version = stdout.split('\n')[0].trim();
    return {version, ok: true};
  } catch {
    return {version: 'not found', ok: false};
  }
}

async function checkPort(port: number): Promise<boolean> {
  try {
    const {stdout} = await execa('lsof', ['-i', `:${port}`, '-t']);
    return stdout.trim().length === 0;
  } catch {
    return true;
  }
}

async function checkPrerequisites(): Promise<void> {
  const spinner = ora('Checking prerequisites...').start();

  const checks = [
    {cmd: 'go', name: 'Go'},
    {cmd: 'uv', name: 'uv (Python)'},
    {cmd: 'node', name: 'Node.js'},
    {cmd: 'npm', name: 'npm'},
  ];

  const results: {name: string; version: string; ok: boolean}[] = [];

  for (const check of checks) {
    const result = await checkCommand(check.cmd, check.name);
    results.push({name: check.name, ...result});
  }

  spinner.stop();

  console.log(chalk.bold('\nPrerequisites:'));
  for (const r of results) {
    if (r.ok) {
      console.log(`  ${chalk.green('✓')} ${r.name}: ${chalk.gray(r.version)}`);
    } else {
      console.log(`  ${chalk.red('✗')} ${r.name}: ${chalk.red('not found')}`);
    }
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.log(
      chalk.red(`\nMissing: ${failed.map((f) => f.name).join(', ')}`)
    );
    console.log('Please install the missing tools and try again.');
    process.exit(1);
  }

  const ports = [8443, 8000, 8080, 3000];
  const portResults: {port: number; available: boolean}[] = [];

  for (const port of ports) {
    const available = await checkPort(port);
    portResults.push({port, available});
  }

  console.log(chalk.bold('\nPorts:'));
  for (const p of portResults) {
    if (p.available) {
      console.log(`  ${chalk.green('✓')} Port ${p.port}: available`);
    } else {
      console.log(`  ${chalk.red('✗')} Port ${p.port}: ${chalk.red('in use')}`);
    }
  }

  const portsInUse = portResults.filter((p) => !p.available);
  if (portsInUse.length > 0) {
    console.log(
      chalk.red(`\nPorts in use: ${portsInUse.map((p) => p.port).join(', ')}`)
    );
    console.log('Please free up these ports and try again.');
    process.exit(1);
  }

  console.log('');
}

async function startDevMode(options: {dashboard: boolean}): Promise<void> {
  try {
    const arkRoot = await findArkRoot();
    console.log(chalk.gray(`Ark root: ${arkRoot}\n`));

    await checkPrerequisites();

    const kubeconfigPath = await writeDevKubeconfig('https://localhost:8443');
    console.log(chalk.gray(`Kubeconfig: ${kubeconfigPath}\n`));

    const services = getDevServices(arkRoot, kubeconfigPath);
    const filteredServices = options.dashboard
      ? services
      : services.filter((s) => s.name !== 'dashboard');

    const manager = new DevProcessManager();

    console.log(chalk.bold('Starting services...\n'));

    for (const service of filteredServices) {
      const spinner = ora(`Starting ${service.name}...`).start();

      try {
        await manager.startService(service);
        spinner.succeed(
          `${service.name} ${chalk.gray(`(http${service.port === 8443 ? 's' : ''}://localhost:${service.port})`)}`
        );
      } catch (error) {
        spinner.fail(`${service.name}: ${error instanceof Error ? error.message : 'failed'}`);
        console.log(chalk.yellow('\nStopping already started services...'));
        await manager.stopAll();
        removeDevKubeconfig();
        process.exit(1);
      }
    }

    console.log(chalk.green('\n✓ Ark is running in dev mode!'));
    if (options.dashboard) {
      console.log(`\nOpen ${chalk.cyan('http://localhost:3000')} to access the dashboard`);
    }
    console.log(chalk.gray('\nPress Ctrl+C to stop all services\n'));

    process.on('SIGINT', async () => {
      console.log(chalk.yellow('\n\nStopping services...'));
      await manager.stopAll();
      removeDevKubeconfig();
      console.log(chalk.green('✓ All services stopped'));
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      await manager.stopAll();
      removeDevKubeconfig();
      process.exit(0);
    });

    await new Promise(() => {});
  } catch (error) {
    console.error(chalk.red(error instanceof Error ? error.message : 'Failed to start dev mode'));
    process.exit(1);
  }
}

async function stopDevMode(): Promise<void> {
  const state = DevProcessManager.loadState();

  if (state.length === 0) {
    console.log(chalk.yellow('No Ark dev services are running.'));
    return;
  }

  console.log(chalk.bold('Stopping services...\n'));

  for (const proc of state.reverse()) {
    if (DevProcessManager.isProcessRunning(proc.pid)) {
      const spinner = ora(`Stopping ${proc.name} (PID ${proc.pid})...`).start();
      DevProcessManager.killProcess(proc.pid);
      spinner.succeed(`${proc.name} stopped`);
    }
  }

  removeDevKubeconfig();
  console.log(chalk.green('\n✓ All services stopped'));
}

async function showStatus(): Promise<void> {
  const state = DevProcessManager.loadState();

  if (state.length === 0) {
    console.log(chalk.yellow('No Ark dev services are running.'));
    console.log(chalk.gray('Run `ark dev start` to start dev mode.'));
    return;
  }

  console.log(chalk.bold('Ark Dev Services:\n'));
  console.log(
    `${'Service'.padEnd(20)} ${'Status'.padEnd(10)} ${'PID'.padEnd(10)} Started`
  );
  console.log('-'.repeat(60));

  for (const proc of state) {
    const isRunning = DevProcessManager.isProcessRunning(proc.pid);
    const status = isRunning ? chalk.green('running') : chalk.red('stopped');
    const pid = isRunning ? proc.pid.toString() : '-';
    const started = new Date(proc.startedAt).toLocaleTimeString();

    console.log(
      `${proc.name.padEnd(20)} ${status.padEnd(19)} ${pid.padEnd(10)} ${started}`
    );
  }
}

async function streamLogs(options: {service?: string}): Promise<void> {
  const logDir = path.join(process.env.HOME || '~', '.ark', 'logs');

  if (!fs.existsSync(logDir)) {
    console.log(chalk.yellow('No logs found. Make sure dev mode is running.'));
    return;
  }

  const services = options.service
    ? [options.service]
    : ['ark-apiserver', 'ark-api', 'executor-langchain', 'dashboard'];

  console.log(chalk.bold('Streaming logs...\n'));
  console.log(chalk.gray('Press Ctrl+C to stop\n'));

  const colors: Record<string, (text: string) => string> = {
    'ark-apiserver': (t) => chalk.blue(t),
    'ark-api': (t) => chalk.green(t),
    'executor-langchain': (t) => chalk.yellow(t),
    dashboard: (t) => chalk.magenta(t),
  };

  for (const service of services) {
    const logFile = path.join(logDir, `${service}.log`);
    if (fs.existsSync(logFile)) {
      const tail = execa('tail', ['-f', logFile]);
      tail.stdout?.on('data', (data: Buffer) => {
        const color = colors[service] || ((t: string) => chalk.white(t));
        const lines = data.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          console.log(`${color(`[${service}]`)} ${line}`);
        }
      });
    }
  }

  await new Promise(() => {});
}

export function createDevCommand(config: ArkConfig): Command {
  const dev = new Command('dev').description(
    'Run Ark locally without Kubernetes'
  );

  dev
    .command('start')
    .description('Start all Ark services locally')
    .option('--no-dashboard', 'Skip starting the dashboard')
    .action(async (options) => {
      await startDevMode({dashboard: options.dashboard});
    });

  dev
    .command('stop')
    .description('Stop all local Ark services')
    .action(async () => {
      await stopDevMode();
    });

  dev
    .command('status')
    .description('Show status of local services')
    .action(async () => {
      await showStatus();
    });

  dev
    .command('logs')
    .description('Stream logs from local services')
    .option('-s, --service <name>', 'Stream logs from specific service')
    .action(async (options) => {
      await streamLogs(options);
    });

  return dev;
}
