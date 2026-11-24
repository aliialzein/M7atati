import type { AuthContext } from '../modules/auth/auth.types.js';

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}
