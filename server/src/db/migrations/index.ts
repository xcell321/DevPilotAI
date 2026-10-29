import type { Migration } from '../migrate';
import { migration001 } from './001-initial';
import { migration002 } from './002-project-path-key';
import { migration003 } from './003-session-runtime';
import { migration004 } from './004-tool-command-source';
import { migration005 } from './005-agent-workspaces';

export const migrations: Migration[] = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
];
