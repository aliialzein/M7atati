import type { Prisma } from '../../generated/prisma/client.js';

import { HttpError } from '../../types/http-error.js';
import { stationScope } from '../../utils/accessScope.js';
import type { AuthContext, UserProfile } from '../auth/auth.types.js';
import { passwordService } from '../auth/password.service.js';
import { usersRepository } from './users.repository.js';
import { managedUser } from './users.types.js';
import type { UserRecord } from './users.types.js';
import type {
  CreateUserInput,
  ListUsersInput,
  UpdateUserInput,
} from './users.validation.js';

type ManagementOperation = 'read' | 'create' | 'update' | 'transfer';

function managementScope(
  actor: UserProfile,
  operation: ManagementOperation,
): Prisma.UserWhereInput {
  if (actor.role === 'ADMIN') return {};
  if (operation === 'transfer') {
    if (actor.role === 'HR') return { role: { name: 'EMPLOYEE' } };
    throw new HttpError('No authorized employee-transfer scope', 403);
  }
  if (actor.role === 'MANAGER') {
    return { role: { name: 'EMPLOYEE' }, station: { is: stationScope(actor) } };
  }
  if (actor.role === 'HR' && operation !== 'update') {
    return { role: { name: 'EMPLOYEE' } };
  }
  throw new HttpError('No authorized user-management scope', 403);
}

export class UsersService {
  constructor(
    private readonly repository = usersRepository,
    private readonly passwords = passwordService,
  ) {}

  private async actor(
    context: AuthContext,
    tx: Prisma.TransactionClient,
    operation: ManagementOperation,
  ): Promise<UserProfile> {
    // Re-read inside the transaction so concurrent deactivation/demotion is observed on retry.
    const current = await this.repository.findUser(context.user.id, {}, tx);
    if (!current?.isActive) throw new HttpError('Unauthenticated', 401);
    const actor = managedUser(current);
    managementScope(actor, operation);
    return actor;
  }

  private async target(
    id: number,
    actor: UserProfile,
    tx: Prisma.TransactionClient,
  ): Promise<UserRecord> {
    const user = await this.repository.findUser(
      id,
      managementScope(actor, 'read'),
      tx,
    );
    if (!user) throw new HttpError('User not found', 404);
    return user;
  }

  private async assignment(
    actor: UserProfile,
    role: string,
    stationId: number | null,
    tx: Prisma.TransactionClient,
    newAssignment = true,
  ): Promise<void> {
    if (actor.role === 'HR' && role !== 'EMPLOYEE') {
      throw new HttpError('HR may create EMPLOYEE accounts only', 403);
    }
    if (role === 'CUSTOMER')
      throw new HttpError('Customer role transitions are not supported', 400);
    if (actor.role === 'MANAGER' && role !== 'EMPLOYEE') {
      throw new HttpError('Managers may manage EMPLOYEE accounts only', 403);
    }
    if (['EMPLOYEE', 'SECURITY'].includes(role) && stationId === null) {
      throw new HttpError('This role requires a station assignment', 400);
    }
    if (['ADMIN', 'HR'].includes(role) && stationId !== null) {
      throw new HttpError('This role cannot have a station assignment', 400);
    }
    if (stationId !== null) {
      const station = await this.repository.findStation(
        {
          AND: [
            { id: stationId },
            actor.role === 'HR' ? {} : stationScope(actor),
            ...(newAssignment ? [{ isActive: true }] : []),
          ],
        },
        tx,
      );
      if (!station)
        throw new HttpError(
          'Station unavailable or outside authorized scope',
          400,
        );
    }
  }

  async list(context: AuthContext, input: ListUsersInput) {
    return this.repository.transaction(async (tx) => {
      const actor = await this.actor(context, tx, 'read');
      const filters: Prisma.UserWhereInput = {
        ...(input.role !== undefined ? { role: { name: input.role } } : {}),
        ...(input.stationId !== undefined
          ? { stationId: input.stationId }
          : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.search
          ? {
              OR: [
                { name: { contains: input.search, mode: 'insensitive' } },
                { email: { contains: input.search, mode: 'insensitive' } },
              ],
            }
          : {}),
      };
      const { users, total } = await this.repository.list(
        { AND: [managementScope(actor, 'read'), filters] },
        input,
        tx,
      );
      return {
        users: users.map(managedUser),
        pagination: {
          page: input.page,
          limit: input.limit,
          total,
          totalPages: Math.ceil(total / input.limit),
        },
      };
    });
  }

  async get(context: AuthContext, id: number) {
    return this.repository.transaction(async (tx) => {
      const actor = await this.actor(context, tx, 'read');
      return managedUser(await this.target(id, actor, tx));
    });
  }

  async create(context: AuthContext, input: CreateUserInput) {
    // Expensive hashing stays outside retryable database transactions.
    const passwordHash = await this.passwords.hash(input.password);
    return this.repository.transaction(async (tx) => {
      const actor = await this.actor(context, tx, 'create');
      const stationId = input.stationId ?? null;
      await this.assignment(actor, input.role, stationId, tx);
      const role = await this.repository.findRole(input.role, tx);
      if (!role) throw new HttpError('Required role is not configured', 409);
      return managedUser(
        await this.repository.create(
          {
            name: input.name,
            email: input.email,
            passwordHash,
            roleId: role.id,
            stationId,
          },
          tx,
        ),
      );
    });
  }

  async update(context: AuthContext, id: number, input: UpdateUserInput) {
    return this.repository.transaction(async (tx) => {
      const actor = await this.actor(context, tx, 'update');
      const target = await this.target(id, actor, tx);
      const nextRole = input.role ?? target.role.name;
      const stationId =
        input.stationId === undefined ? target.stationId : input.stationId;
      if (target.role.name === 'CUSTOMER') {
        if (input.role !== undefined || input.stationId !== undefined) {
          throw new HttpError(
            'Customer role and station changes are not supported',
            400,
          );
        }
      } else {
        await this.assignment(
          actor,
          nextRole,
          stationId,
          tx,
          stationId !== target.stationId,
        );
      }
      // Check the original assignment even when this request changes role too.
      if (
        stationId !== target.stationId &&
        (target.role.name === 'EMPLOYEE' || nextRole === 'EMPLOYEE')
      ) {
        await this.requireTransferable(target, tx);
      }
      const roleChanged = nextRole !== target.role.name;
      if (
        roleChanged &&
        target.role.name === 'MANAGER' &&
        (await this.repository.countManagedStations(id, tx)) > 0
      ) {
        throw new HttpError(
          'Reassign managed stations before changing this role',
          409,
        );
      }
      if (roleChanged && target.isActive && target.role.name === 'ADMIN') {
        await this.protectFinalAdmin(tx);
      }
      const role = roleChanged
        ? await this.repository.findRole(nextRole, tx)
        : undefined;
      if (roleChanged && !role)
        throw new HttpError('Required role is not configured', 409);
      const updated = await this.repository.update(
        id,
        {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(role ? { roleId: role.id } : {}),
          ...(input.stationId !== undefined ? { stationId } : {}),
        },
        tx,
      );
      if (roleChanged || stationId !== target.stationId)
        await this.repository.revokeSessions(id, tx);
      return managedUser(updated);
    });
  }

  private async requireTransferable(
    target: UserRecord,
    tx: Prisma.TransactionClient,
  ) {
    if (
      target.stationId !== null &&
      (await this.repository.hasTransferConflict(
        target.id,
        target.stationId,
        new Date(Date.now()),
        tx,
      ))
    ) {
      throw new HttpError(
        'Employee has open attendance or ongoing or future shifts at the source station',
        409,
      );
    }
  }

  async transfer(context: AuthContext, id: number, stationId: number) {
    return this.repository.transaction(async (tx) => {
      const actor = await this.actor(context, tx, 'transfer');
      const target = await this.target(id, actor, tx);
      if (target.role.name !== 'EMPLOYEE')
        throw new HttpError('User not found', 404);
      if (target.stationId === stationId) return managedUser(target);
      await this.assignment(actor, 'EMPLOYEE', stationId, tx);
      await this.requireTransferable(target, tx);
      const updated = await this.repository.update(id, { stationId }, tx);
      await this.repository.revokeSessions(id, tx);
      return managedUser(updated);
    });
  }

  private async protectFinalAdmin(tx: Prisma.TransactionClient): Promise<void> {
    if ((await this.repository.countActiveAdmins(tx)) <= 1) {
      throw new HttpError('Cannot remove the final active ADMIN', 409);
    }
  }

  async setStatus(context: AuthContext, id: number, isActive: boolean) {
    return this.repository.transaction(async (tx) => {
      const actor = await this.actor(context, tx, 'update');
      const target = await this.target(id, actor, tx);
      if (!isActive && target.isActive && target.role.name === 'ADMIN')
        await this.protectFinalAdmin(tx);
      const updated = await this.repository.update(
        id,
        {
          isActive,
          ...(!isActive && target.isActive
            ? { tokenVersion: { increment: 1 } }
            : {}),
        },
        tx,
      );
      if (!isActive) await this.repository.revokeSessions(id, tx);
      return managedUser(updated);
    });
  }
}

export const usersService = new UsersService();
