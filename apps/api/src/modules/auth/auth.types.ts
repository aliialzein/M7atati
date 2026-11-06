export const ACCESS_COOKIE = 'm7atati_access';
export const REFRESH_COOKIE = 'm7atati_refresh';

export interface AuthUser {
  id: number;
  name: string;
  email: string;
  passwordHash: string;
  isActive: boolean;
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

export interface AuthContext {
  user: UserProfile;
  permissions: readonly string[];
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  tokenHash: string;
  expiresAt: Date;
}

export interface AuthResult {
  user: UserProfile;
  tokens: TokenPair;
}

export function userProfile(user: AuthUser): UserProfile {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role.name,
    stationId: user.stationId,
  };
}
