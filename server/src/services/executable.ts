import fs from 'node:fs';
import path from 'node:path';

export interface ExecutableInspection {
  absolute: boolean;
  exists: boolean;
  isFile: boolean;
  executable: boolean;
  errorCode?: string;
}

function pathApiFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

export function inspectExecutable(
  candidate: string,
  platform: NodeJS.Platform = process.platform,
): ExecutableInspection {
  const pathApi = pathApiFor(platform);
  if (!pathApi.isAbsolute(candidate)) {
    return { absolute: false, exists: false, isFile: false, executable: false };
  }

  let stats: fs.Stats;
  try {
    stats = fs.statSync(candidate);
  } catch (error) {
    return {
      absolute: true,
      exists: false,
      isFile: false,
      executable: false,
      errorCode: (error as NodeJS.ErrnoException).code,
    };
  }

  if (!stats.isFile()) {
    return { absolute: true, exists: true, isFile: false, executable: false };
  }

  if (platform === 'win32') {
    return { absolute: true, exists: true, isFile: true, executable: true };
  }

  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return { absolute: true, exists: true, isFile: true, executable: true };
  } catch {
    return { absolute: true, exists: true, isFile: true, executable: false };
  }
}

export function isExecutableFile(
  candidate: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return inspectExecutable(candidate, platform).executable;
}
