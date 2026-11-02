import { z } from 'zod';
import { MAX_ID_LENGTH } from '../limits';

export const idSchema = z.string().trim().min(1).max(MAX_ID_LENGTH);
