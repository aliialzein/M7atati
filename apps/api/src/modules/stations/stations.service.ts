import type { Prisma } from '../../generated/prisma/client.js';
import type { AuthContext, UserProfile } from '../auth/auth.types.js';
import { stationScope } from '../../utils/accessScope.js';
import { HttpError } from '../../types/http-error.js';
import { stationsRepository } from './stations.repository.js';
import { managedStation, pickerStation } from './stations.types.js';
import { coordinatesSchema } from './stations.validation.js';
import type {
  CreateStationInput,
  ListStationsInput,
  UpdateStationInput,
} from './stations.validation.js';

export class StationsService {
  constructor(private readonly repository = stationsRepository) {}

  pumps(actor: UserProfile, id: number) {
    if (!['ADMIN', 'MANAGER'].includes(actor.role))
      throw new HttpError('Insufficient permissions', 403);
    return this.repository.transaction(async (tx) => {
      const station = await this.repository.pumpLookup(
        { AND: [{ id }, stationScope(actor)] },
        tx,
      );
      if (!station) throw new HttpError('Station not found', 404);
      if (!station.isActive) throw new HttpError('Station is inactive', 409);
      return {
        pumps: station.pumps.map(({ id, number, status, _count }) => ({
          id,
          number,
          status,
          available: status === 'IDLE' && _count.orders === 0,
        })),
      };
    });
  }

  async setManager(context: AuthContext, id: number, managerId: number | null) {
    return this.repository.transaction(async (tx) => {
      const actor = await this.repository.assignmentUser(context.user.id, tx);
      if (!actor?.isActive) throw new HttpError('Unauthenticated', 401);
      if (
        actor.role.name !== 'ADMIN' ||
        !actor.role.permissions.some(
          ({ permission }) => permission.key === 'stations.update',
        )
      )
        throw new HttpError('Insufficient permissions', 403);

      // User -> station matches existing lifecycle and cash/fulfillment ordering.
      // Holding the candidate row lock keeps eligibility valid through commit.
      if (managerId !== null) await this.repository.lockManager(managerId, tx);
      await this.repository.lockStation(id, tx);
      const station = await this.requireStation(id, tx);
      if (managerId !== null) {
        const manager = await this.repository.assignmentUser(managerId, tx);
        if (!manager) throw new HttpError('Manager not found', 404);
        if (!manager.isActive || manager.role.name !== 'MANAGER')
          throw new HttpError('User must be an active MANAGER', 409);
        const owned = await this.repository.ownedStation(managerId, tx);
        if (owned && owned.id !== id)
          throw new HttpError('Manager already owns another station', 409);
      }
      if (station.managerId === managerId) return managedStation(station);
      return managedStation(
        await this.repository.update(id, { managerId }, tx),
      );
    });
  }

  async managed(actor: UserProfile) {
    if (actor.role !== 'MANAGER')
      throw new HttpError('Insufficient permissions', 403);
    const stations = await this.repository.managed(stationScope(actor));
    return {
      stations: stations.map(({ id, name, isActive }) => ({
        id,
        name,
        isActive,
      })),
    };
  }

  private async requireStation(id: number, tx: Prisma.TransactionClient) {
    const station = await this.repository.find(id, tx);
    if (!station) throw new HttpError('Station not found', 404);
    return station;
  }
  async picker() {
    return { stations: (await this.repository.picker()).map(pickerStation) };
  }
  async create(input: CreateStationInput) {
    return managedStation(await this.repository.create(input));
  }
  async list(input: ListStationsInput) {
    const where: Prisma.StationWhereInput = {
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      ...(input.search
        ? {
            OR: [
              { name: { contains: input.search, mode: 'insensitive' } },
              { address: { contains: input.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    return this.repository.transaction(async (tx) => {
      const { stations, total } = await this.repository.list(where, input, tx);
      return {
        stations: stations.map(managedStation),
        pagination: {
          page: input.page,
          limit: input.limit,
          total,
          totalPages: Math.ceil(total / input.limit),
        },
      };
    });
  }
  async get(id: number) {
    return this.repository.transaction(async (tx) =>
      managedStation(await this.requireStation(id, tx)),
    );
  }
  async update(id: number, input: UpdateStationInput) {
    return this.repository.transaction(async (tx) => {
      const station = await this.requireStation(id, tx);
      // Validate the resulting pair inside the same retryable transaction as the write.
      coordinatesSchema.parse({
        latitude:
          input.latitude === undefined
            ? station.latitude === null
              ? null
              : Number(station.latitude)
            : input.latitude,
        longitude:
          input.longitude === undefined
            ? station.longitude === null
              ? null
              : Number(station.longitude)
            : input.longitude,
      });
      return managedStation(await this.repository.update(id, input, tx));
    });
  }
  async setStatus(id: number, isActive: boolean) {
    return this.repository.transaction(async (tx) => {
      await this.repository.lockStation(id, tx);
      const station = await this.requireStation(id, tx);
      // Check even an already-inactive legacy station; reactivation must remain
      // available to recover it, but deactivation cannot acknowledge active work.
      // Cash confirmation and fulfillment hold FOR SHARE on this same station
      // through their order/payment/event commit. FOR UPDATE above plus the
      // Serializable retry prevents checking an obsolete pre-payment snapshot.
      if (!isActive && (await this.repository.hasBlockingOrder(id, tx)))
        throw new HttpError(
          'Station has active orders; complete them before deactivating the station',
          409,
        );
      if (station.isActive === isActive) return managedStation(station);
      return managedStation(await this.repository.update(id, { isActive }, tx));
    });
  }
}
export const stationsService = new StationsService();
