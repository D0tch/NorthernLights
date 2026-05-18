import jwt from 'jsonwebtoken';
import { getJwtSecret, JwtPayload } from './auth.service';

export type ScopedTokenScope = 'media' | 'sse';

export interface ScopedTokenPayload extends JwtPayload {
  scope: ScopedTokenScope;
}

const SCOPED_TOKEN_EXPIRY = '7d';

export async function generateScopedToken(scope: ScopedTokenScope, user: JwtPayload): Promise<string> {
  const secret = await getJwtSecret();
  const payload: ScopedTokenPayload = {
    userId: user.userId,
    username: user.username,
    role: user.role,
    scope,
  };
  return jwt.sign(payload, secret, { expiresIn: SCOPED_TOKEN_EXPIRY });
}

export async function verifyScopedToken(token: string, scope: ScopedTokenScope): Promise<ScopedTokenPayload | null> {
  try {
    const secret = await getJwtSecret();
    const decoded = jwt.verify(token, secret) as ScopedTokenPayload;
    if (decoded.scope !== scope) return null;
    if (!decoded.userId || !decoded.username || !decoded.role) return null;
    return decoded;
  } catch {
    return null;
  }
}
