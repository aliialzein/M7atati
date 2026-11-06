import type { Prisma } from '../generated/prisma/client.js';
import type { UserProfile } from '../modules/auth/auth.types.js';
import { HttpError } from '../types/http-error.js';

// Resource services must combine this predicate with their own capability rules.
export function stationScope(
  actor: Pick<UserProfile, 'id' | 'role' | 'stationId'>,
): Prisma.StationWhereInput {
  switch (actor.role) {
    case 'ADMIN':
      return {};
    case 'MANAGER':
      return { managerId: actor.id };
    case 'EMPLOYEE':
      return actor.stationId === null
        ? { id: { in: [] } }
        : { id: actor.stationId };
    default:
      throw new HttpError('No authorized station scope', 403);
  }
}
