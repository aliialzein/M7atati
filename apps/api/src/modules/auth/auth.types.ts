export const ACCESS_COOKIE = 'm7atati_access';
export const REFRESH_COOKIE = 'm7atati_refresh';

export interface AuthUser {
  id: number;
  name: string;
  email: string;
  passwordHash: string;
  isActive: boolean;
  tokenVersion: number;
  stationId: number | null;
  role: {
    name: string;
    permissions: { permission: { key: string } }[];
  };
}

export interface UserProfile {
  id: number;
  name: string;
  email: string;
  role: string;
  stationId: number | null;
}

export interface AuthenticatedUserProfile extends UserProfile {
  permissions: string[];
}

export interface AuthContext {
  user: UserProfile;
  permissions: readonly string[];
}

export interface TokenPair {
  tokenVersion: number;
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  tokenHash: string;
  expiresAt: Date;
}

export interface AuthResult {
  user: AuthenticatedUserProfile;
  tokens: TokenPair;
}

export function userProfile(user: AuthUser): AuthenticatedUserProfile {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role.name,
    stationId: user.stationId,
    permissions: [
      ...new Set(user.role.permissions.map(({ permission }) => permission.key)),
    ].sort(),
  };
}
