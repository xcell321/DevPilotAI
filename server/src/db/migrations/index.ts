import type { Migration } from '../migrate';
import { migration001 } from './001-initial';
import { migration002 } from './002-project-path-key';
import { migration003 } from './003-session-runtime';

export const migrations: Migration[] = [migration001, migration002, migration003];
