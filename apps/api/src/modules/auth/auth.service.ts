import { HttpError } from '../../types/http-error.js';
import { authRepository } from './auth.repository.js';
import { userProfile } from './auth.types.js';
import type { AuthContext, AuthResult } from './auth.types.js';
import type { LoginInput, RegisterInput } from './auth.validation.js';
import { passwordService } from './password.service.js';
import { tokenService } from './token.service.js';

export class AuthService {
  constructor(
    private readonly repository = authRepository,
    private readonly passwords = passwordService,
    private readonly tokens = tokenService,
  ) {}

  async register(input: RegisterInput): Promise<AuthResult> {
    const result = await this.repository.createCustomer(
      {
        name: input.name,
        email: input.email,
        passwordHash: await this.passwords.hash(input.password),
      },
      (id) => this.tokens.issue(id),
    );
    return { user: userProfile(result.user), tokens: result.tokens };
  }

  async login(input: LoginInput): Promise<AuthResult> {
    const user = await this.repository.findUserByEmail(input.email);
    const valid = await this.passwords.verify(
      input.password,
      user?.passwordHash,
    );
    if (!user || !valid || !user.isActive) {
      throw new HttpError('Invalid credentials', 401);
    }
    const tokens = this.tokens.issue(user.id);
    await this.repository.createSession(user.id, tokens);
    return { user: userProfile(user), tokens };
  }

  async refresh(token: string | undefined): Promise<AuthResult> {
    const { userId, sessionId } = this.tokens.verifyRefresh(token);
    const session = await this.repository.findSession(sessionId);
    const oldHash = this.tokens.hash(token!);
    if (
      !session ||
      session.userId !== userId ||
      session.revokedAt ||
      session.expiresAt <= new Date() ||
      session.tokenHash !== oldHash ||
      !session.user.isActive
    ) {
      throw new HttpError('Unauthenticated', 401);
    }
    const tokens = this.tokens.issue(userId, sessionId);
    if (!(await this.repository.rotateSession(userId, oldHash, tokens))) {
      throw new HttpError('Unauthenticated', 401);
    }
    return { user: userProfile(session.user), tokens };
  }

  async logout(token: string | undefined): Promise<void> {
    let session;
    try {
      session = this.tokens.verifyRefresh(token);
    } catch (error) {
      if (error instanceof HttpError && error.statusCode === 401) return;
      throw error;
    }
    await this.repository.revokeSession(session.sessionId, session.userId);
  }

  async authenticate(token: string | undefined): Promise<AuthContext> {
    const id = this.tokens.verifyAccess(token);
    const user = await this.repository.findUserById(id);
    if (!user?.isActive) throw new HttpError('Unauthenticated', 401);
    return {
      user: userProfile(user),
      permissions: user.role.permissions.map(
        ({ permission }) => permission.key,
      ),
    };
  }
}

export const authService = new AuthService();
