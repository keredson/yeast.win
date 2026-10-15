export interface BuildInfo {
  version: string;
  environment: 'development' | 'production';
  commit: string | null;
  dirty: boolean;
  builtAt: string | null;
}

export interface DeploymentInfo extends BuildInfo {
  startedAt: string;
}
