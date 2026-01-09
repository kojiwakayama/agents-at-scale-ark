export interface DevService {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  port: number;
  healthCheck: string;
  env?: Record<string, string>;
  startupTimeout?: number;
}

export interface ServiceStatus {
  name: string;
  status: 'running' | 'stopped' | 'starting' | 'error';
  port: number;
  pid?: number;
  error?: string;
}

export interface DevState {
  services: ServiceStatus[];
  startedAt?: Date;
  kubeconfigPath?: string;
}
