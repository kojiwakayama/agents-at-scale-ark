import fs from 'fs';
import path from 'path';
import os from 'os';

export function generateDevKubeconfig(apiserverUrl: string): string {
  return `apiVersion: v1
kind: Config
clusters:
- cluster:
    server: ${apiserverUrl}
    insecure-skip-tls-verify: true
  name: ark-dev
contexts:
- context:
    cluster: ark-dev
    namespace: default
    user: ark-dev-user
  name: ark-dev
current-context: ark-dev
users:
- name: ark-dev-user
  user: {}
`;
}

export function getKubeconfigPath(): string {
  const arkDir = path.join(os.homedir(), '.ark');
  return path.join(arkDir, 'dev-kubeconfig.yaml');
}

export async function writeDevKubeconfig(apiserverUrl: string): Promise<string> {
  const kubeconfigPath = getKubeconfigPath();
  const arkDir = path.dirname(kubeconfigPath);

  if (!fs.existsSync(arkDir)) {
    fs.mkdirSync(arkDir, {recursive: true});
  }

  const kubeconfig = generateDevKubeconfig(apiserverUrl);
  fs.writeFileSync(kubeconfigPath, kubeconfig, 'utf-8');

  return kubeconfigPath;
}

export function removeDevKubeconfig(): void {
  const kubeconfigPath = getKubeconfigPath();
  if (fs.existsSync(kubeconfigPath)) {
    fs.unlinkSync(kubeconfigPath);
  }
}
