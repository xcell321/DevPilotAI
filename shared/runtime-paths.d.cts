export const DEFAULT_RUNTIME_DIR_NAME: string;

export function resolveRuntimeDir(root: string, env?: NodeJS.ProcessEnv): string;

export function runtimeFileFor(root: string, env?: NodeJS.ProcessEnv): string;
