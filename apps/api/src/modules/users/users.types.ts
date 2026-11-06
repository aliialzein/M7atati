export const roles = [
  'ADMIN',
  'MANAGER',
  'EMPLOYEE',
  'HR',
  'SECURITY',
  'CUSTOMER',
] as const;
export type RoleName = (typeof roles)[number];

export interface UserRecord {
  id: number;
  name: string;
  email: string;
  role: { name: string };
  stationId: number | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type ManagedUser = Omit<UserRecord, 'role'> & { role: string };

export function managedUser(user: UserRecord): ManagedUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role.name,
    stationId: user.stationId,
    isActive: user.isActive,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}
