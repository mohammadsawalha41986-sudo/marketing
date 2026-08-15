/**
 * The signed-in operator.
 *
 * This file is what is left of `scope.ts`, which used to decide which rows an
 * actor could reach. That question no longer exists: one operator owns every
 * row in the database, so there is no scope to derive and no tenant boundary to
 * enforce. Authentication alone answers "may this request proceed".
 *
 * Restaurants are still kept strictly apart from one another — content for one
 * never appears under another — but that is ordinary foreign-key correctness in
 * each query, not an access-control decision.
 */

import type { Role } from '@prisma/client';

export interface Actor {
  id: string;
  email: string;
  name: string;
  role: Role;
}
