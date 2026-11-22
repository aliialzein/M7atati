import type { Prisma } from '../../generated/prisma/client.js';
import type { UserProfile } from '../auth/auth.types.js';
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
      if (!isActive && (await this.repository.hasInProgressOrder(id, tx)))
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
