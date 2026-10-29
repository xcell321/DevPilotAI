import type { Migration } from '../migrate';
import { migration001 } from './001-initial';
import { migration002 } from './002-project-path-key';
import { migration003 } from './003-session-runtime';
import { migration004 } from './004-tool-command-source';
import { migration005 } from './005-agent-workspaces';
import { migration006 } from './006-workspace-mode';
import { migration007 } from './007-agent-tasks-and-branches';
import { migration008 } from './008-orchestration';
import { migration009 } from './009-integration-candidate-validation';
import { migration010 } from './010-workflow-coordination';
import { migration011 } from './011-lease-index-project-scope';

export const migrations: Migration[] = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
  migration006,
  migration007,
  migration008,
  migration009,
  migration010,
  migration011,
];
