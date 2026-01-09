import path from 'path';
import type {DevService} from './types.js';

export function getDevServices(arkRoot: string, kubeconfigPath: string): DevService[] {
  return [
    {
      name: 'ark-apiserver',
      command: 'go',
      args: [
        'run',
        './cmd/apiserver',
        '--secure-port=8443',
        '--storage-driver=sqlite',
        '--sqlite-path=./data/ark-dev.db',
      ],
      cwd: path.join(arkRoot, 'services/ark-apiserver'),
      port: 8443,
      healthCheck: 'https://localhost:8443/healthz',
      startupTimeout: 60000,
    },
    {
      name: 'ark-api',
      command: 'uv',
      args: ['run', 'python', '-m', 'ark_api'],
      cwd: path.join(arkRoot, 'services/ark-api/ark-api'),
      port: 8000,
      healthCheck: 'http://localhost:8000/health',
      env: {
        KUBECONFIG: kubeconfigPath,
        ARK_NAMESPACE: 'default',
      },
      startupTimeout: 30000,
    },
    {
      name: 'executor-langchain',
      command: 'uv',
      args: ['run', 'python', '-m', 'langchain_executor'],
      cwd: path.join(arkRoot, 'services/executor-langchain'),
      port: 8080,
      healthCheck: 'http://localhost:8080/health',
      env: {
        PORT: '8080',
      },
      startupTimeout: 30000,
    },
    {
      name: 'dashboard',
      command: 'npm',
      args: ['run', 'dev'],
      cwd: path.join(arkRoot, 'services/ark-dashboard/ark-dashboard'),
      port: 3000,
      healthCheck: 'http://localhost:3000',
      env: {
        AUTH_MODE: 'open',
        ARK_API_SERVICE_HOST: 'localhost',
        ARK_API_SERVICE_PORT: '8000',
        ARK_API_SERVICE_PROTOCOL: 'http',
      },
      startupTimeout: 60000,
    },
  ];
}
