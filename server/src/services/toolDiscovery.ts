import path from 'node:path';
import { getToolDefinition } from './toolCatalog';
import { isExecutableFile } from './executable';

export type ToolCommandSource = 'configured' | 'path' | 'known-location' | 'missing';

export interface ToolCommandResolution {
  command: string;
  source: ToolCommandSource;
}

function pathApiFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

function expandKnownPath(template: string, env: NodeJS.ProcessEnv, homeDir: string): string {
  if (/^~(?=$|[\\/])/.test(template) && !homeDir) return '';

  let missingValue = false;
  const expanded = template.replace(/%([^%]+)%/g, (_match, key: string) => {
    const value = env[key];
    if (!value) missingValue = true;
    return value ?? '';
  });
  if (missingValue) return '';
  return expanded.replace(/^~(?=$|[\\/])/, homeDir);
}

function searchPath(
  executableNames: string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | null {
  const pathApi = pathApiFor(platform);
  const pathValue = env.PATH ?? env.Path ?? '';
  const delimiter = platform === 'win32' ? ';' : ':';

  for (const name of executableNames) {
    for (const directory of pathValue.split(delimiter)) {
      if (!directory) continue;
      const candidate = pathApi.join(directory, name);
      if (isExecutableFile(candidate, platform)) return candidate;
    }
  }
  return null;
}

function searchKnownPaths(
  knownPaths: string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  homeDir: string,
): string | null {
  const pathApi = pathApiFor(platform);

  for (const template of knownPaths) {
    const isWindowsTemplate = template.includes('%');
    if (platform === 'win32' ? !isWindowsTemplate : isWindowsTemplate) continue;

    const expanded = expandKnownPath(template, env, homeDir);
    if (!expanded) continue;
    const candidate = pathApi.normalize(expanded);
    if (isExecutableFile(candidate, platform)) return candidate;
  }
  return null;
}

export function resolveToolCommand(
  toolId: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ToolCommandResolution {
  const definition = getToolDefinition(toolId);
  if (!definition) return { command: '', source: 'missing' };

  const configured = env[definition.envVar]?.trim();
  if (configured) {
    return { command: configured, source: 'configured' };
  }

  if (definition.executableNames.length === 0) {
    return { command: '', source: 'missing' };
  }

  const homeDir = env.USERPROFILE ?? env.HOME ?? '';
  const known = searchKnownPaths(definition.knownPaths, env, platform, homeDir);
  if (known) return { command: known, source: 'known-location' };

  const fromPath = searchPath(definition.executableNames, env, platform);
  if (fromPath) return { command: fromPath, source: 'path' };

  return { command: '', source: 'missing' };
}
