import type { Prisma } from '../generated/prisma/client.js';
import type { UserProfile } from '../modules/auth/auth.types.js';
import { HttpError } from '../types/http-error.js';

// Shared by manager attendance/reports and demo orders. The lookup includes
// ownership, so unknown and unmanaged stations have the same response.
export async function requireManagedStation(
  actor: Pick<UserProfile, 'id' | 'role' | 'stationId'>,
  stationId: number,
  database: Pick<Prisma.TransactionClient, 'station'>,
) {
  if (actor.role !== 'MANAGER')
    throw new HttpError('Insufficient permissions', 403);
  const station = await database.station.findFirst({
    where: { AND: [{ id: stationId }, stationScope(actor)] },
    select: { id: true, name: true, isActive: true },
  });
  if (!station) throw new HttpError('Station not found', 404);
  return station;
}

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
