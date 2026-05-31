import { Router } from 'express';
import crypto from 'crypto';
import { hasUsers, createUser, getUserByUsername, getUserById, updateUser, deleteUser, updateLastLogin, createInvite, getInvite, isInviteValid, incrementInviteUses, createSubsonicApiKey, listSubsonicApiKeys, revokeSubsonicApiKey, rotateSubsonicApiKey, deleteRevokedSubsonicApiKey } from '../database';
import { hashPassword, verifyPassword, generateToken, JwtPayload } from '../services/auth.service';
import { generateScopedToken } from '../services/scopedToken.service';
import { queueLlmHubRefreshForUser } from '../services/hubRefresh.service';
import { createRateLimiter } from '../middleware/rateLimit';

const router = Router();
const MIN_PASSWORD_LENGTH = 12;
const SUBSONIC_API_KEY_PREFIX_LENGTH = 18;
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_BLOCK_MS = 15 * 60 * 1000;
const AUTH_LIMITS: Record<string, number> = {
  login: 8,
  register: 5,
  setup: 5,
};
const authStatusRateLimit = createRateLimiter({
  keyPrefix: 'auth:status',
  windowMs: 60 * 1000,
  max: 120,
});
const authPublicMutationRateLimit = createRateLimiter({
  keyPrefix: 'auth:public-mutation',
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: 'Too many auth requests. Try again later.',
});
const authAccountMutationRateLimit = createRateLimiter({
  keyPrefix: 'auth:account-mutation',
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Too many account requests. Try again later.',
});
const authKeyMutationRateLimit = createRateLimiter({
  keyPrefix: 'auth:subsonic-key-mutation',
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Too many API key requests. Try again later.',
});
const inviteValidationRateLimit = createRateLimiter({
  keyPrefix: 'auth:invite-validate',
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: 'Too many invite checks. Try again later.',
});

type AuthAttempt = { count: number; firstAt: number; blockedUntil: number };
const authAttempts = new Map<string, AuthAttempt>();

function getClientIp(req: any): string {
  return String(req.ip || req.socket?.remoteAddress || 'unknown');
}

function getAttemptKey(req: any, bucket: keyof typeof AUTH_LIMITS, username?: unknown): string {
  const normalizedUsername = typeof username === 'string' ? username.trim().toLowerCase() : '';
  return `${bucket}:${getClientIp(req)}:${normalizedUsername}`;
}

function consumeAuthAttempt(req: any, res: any, bucket: keyof typeof AUTH_LIMITS, username?: unknown): boolean {
  const key = getAttemptKey(req, bucket, username);
  const now = Date.now();
  const existing = authAttempts.get(key);

  if (existing?.blockedUntil && existing.blockedUntil > now) {
    const retryAfter = Math.ceil((existing.blockedUntil - now) / 1000);
    res.setHeader('Retry-After', String(retryAfter));
    res.status(429).json({ error: 'Too many attempts. Try again later.' });
    return false;
  }

  const next: AuthAttempt = existing && now - existing.firstAt < AUTH_WINDOW_MS
    ? { ...existing, count: existing.count + 1, blockedUntil: 0 }
    : { count: 1, firstAt: now, blockedUntil: 0 };

  if (next.count > AUTH_LIMITS[bucket]) {
    next.blockedUntil = now + AUTH_BLOCK_MS;
    authAttempts.set(key, next);
    res.setHeader('Retry-After', String(Math.ceil(AUTH_BLOCK_MS / 1000)));
    res.status(429).json({ error: 'Too many attempts. Try again later.' });
    return false;
  }

  authAttempts.set(key, next);
  return true;
}

function generateSubsonicApiKeySecret() {
  const key = `aurora_sub_${crypto.randomBytes(32).toString('base64url')}`;
  return {
    key,
    keyPrefix: key.slice(0, SUBSONIC_API_KEY_PREFIX_LENGTH),
    keyHash: `sha256:${crypto.createHash('sha256').update(key, 'utf8').digest('hex')}`,
  };
}

function serializeSubsonicApiKey(row: any) {
  return {
    id: row.id,
    name: row.name,
    prefix: row.key_prefix,
    createdAt: row.created_at ? new Date(row.created_at).getTime() : null,
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at).getTime() : null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at).getTime() : null,
  };
}

function clearAuthAttempts(req: any, bucket: keyof typeof AUTH_LIMITS, username?: unknown) {
  authAttempts.delete(getAttemptKey(req, bucket, username));
}

async function buildAuthResponse(payload: JwtPayload) {
  const [token, mediaToken, sseToken] = await Promise.all([
    generateToken(payload),
    generateScopedToken('media', payload),
    generateScopedToken('sse', payload),
  ]);
  return { token, mediaToken, sseToken };
}

// Setup: check if initial admin needs to be created
router.get('/setup/status', authStatusRateLimit, async (req, res) => {
  try {
    const usersExist = await hasUsers();
    res.json({ needsSetup: !usersExist, dbConnected: true });
  } catch (error: any) {
    if (error.code === 'ECONNREFUSED') {
      return res.json({ needsSetup: null, dbConnected: false, error: 'Database unavailable' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Setup: complete initial admin creation
router.post('/setup/complete', authPublicMutationRateLimit, async (req, res) => {
  const needsSetup = !(await hasUsers());
  if (!needsSetup) {
    return res.status(403).json({ error: 'Setup is already complete.' });
  }

  const { username, password } = req.body;
  if (!consumeAuthAttempt(req, res, 'setup', username)) return;
  if (!username || !password || username.length < 3 || password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: 'Invalid username or password. Ensure they are strong.' });
  }

  try {
    const passwordHash = await hashPassword(password);
    const user = await createUser(username, passwordHash, 'admin');
    const auth = await buildAuthResponse({ userId: user.id, username: user.username, role: user.role });
    clearAuthAttempts(req, 'setup', username);
    res.json({ status: 'completed', ...auth, user: { id: user.id, username: user.username, role: user.role } });
  } catch (error) {
    console.error('Failed to complete setup:', error);
    res.status(500).json({ error: 'Failed to create admin user.' });
  }
});

// Login
router.post('/login', authPublicMutationRateLimit, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    if (!consumeAuthAttempt(req, res, 'login', username)) return;

    const user = await getUserByUsername(username);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    await updateLastLogin(user.id);
    const auth = await buildAuthResponse({ userId: user.id, username: user.username, role: user.role });
    clearAuthAttempts(req, 'login', username);
    queueLlmHubRefreshForUser(user.id, 'login');
    res.json({ ...auth, user: { id: user.id, username: user.username, role: user.role } });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Register via invite
router.post('/register', authPublicMutationRateLimit, async (req, res) => {
  try {
    const { inviteToken, username, password } = req.body;
    if (!inviteToken || !username || !password) {
      return res.status(400).json({ error: 'Invite token, username, and password required' });
    }
    if (!consumeAuthAttempt(req, res, 'register', username)) return;

    if (username.length < 3 || password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `Username must be 3+ chars, password ${MIN_PASSWORD_LENGTH}+ chars` });
    }

    const valid = await isInviteValid(inviteToken);
    if (!valid) {
      return res.status(400).json({ error: 'Invalid or expired invite' });
    }

    const invite = await getInvite(inviteToken);
    const existingUser = await getUserByUsername(username);
    if (existingUser) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    const passwordHash = await hashPassword(password);
    const user = await createUser(username, passwordHash, invite.role);
    await incrementInviteUses(inviteToken);
    const auth = await buildAuthResponse({ userId: user.id, username: user.username, role: user.role });
    clearAuthAttempts(req, 'register', username);
    res.json({ ...auth, user: { id: user.id, username: user.username, role: user.role } });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Get current user
router.get('/me', authStatusRateLimit, (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ user: req.user });
});

// Change password
router.post('/change-password', authAccountMutationRateLimit, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current and new password required' });
    if (newPassword.length < MIN_PASSWORD_LENGTH) return res.status(400).json({ error: `New password must be ${MIN_PASSWORD_LENGTH}+ characters` });

    const user = await getUserByUsername(req.user.username);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const valid = await verifyPassword(currentPassword, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

    const newHash = await hashPassword(newPassword);
    await updateUser(user.id, { passwordHash: newHash });
    res.json({ status: 'changed' });
  } catch (error) {
    console.error('Password change error:', error);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

router.get('/subsonic-api-keys', authStatusRateLimit, async (req, res) => {
  try {
    if (!req.user?.userId) return res.status(401).json({ error: 'Not authenticated' });
    const keys = await listSubsonicApiKeys(req.user.userId);
    res.json({
      keys: keys.map(serializeSubsonicApiKey),
    });
  } catch (error) {
    console.error('Subsonic key list error:', error);
    res.status(500).json({ error: 'Failed to list API keys' });
  }
});

router.post('/subsonic-api-keys', authKeyMutationRateLimit, async (req, res) => {
  try {
    if (!req.user?.userId) return res.status(401).json({ error: 'Not authenticated' });
    const rawName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const name = rawName.slice(0, 80) || 'Subsonic client';
    const { key, keyPrefix, keyHash } = generateSubsonicApiKeySecret();
    const row = await createSubsonicApiKey(req.user.userId, name, keyPrefix, keyHash);
    res.status(201).json({
      key,
      record: serializeSubsonicApiKey(row),
    });
  } catch (error) {
    console.error('Subsonic key create error:', error);
    res.status(500).json({ error: 'Failed to create API key' });
  }
});

router.post('/subsonic-api-keys/:id/rotate', authKeyMutationRateLimit, async (req, res) => {
  try {
    if (!req.user?.userId) return res.status(401).json({ error: 'Not authenticated' });
    const { key, keyPrefix, keyHash } = generateSubsonicApiKeySecret();
    const row = await rotateSubsonicApiKey(req.user.userId, String(req.params.id), keyPrefix, keyHash);
    if (!row) return res.status(404).json({ error: 'Active API key not found' });
    res.json({
      key,
      record: serializeSubsonicApiKey(row),
    });
  } catch (error) {
    console.error('Subsonic key rotate error:', error);
    res.status(500).json({ error: 'Failed to rotate API key' });
  }
});

router.delete('/subsonic-api-keys/:id', authKeyMutationRateLimit, async (req, res) => {
  try {
    if (!req.user?.userId) return res.status(401).json({ error: 'Not authenticated' });
    const keyId = String(req.params.id);
    const revoked = await revokeSubsonicApiKey(req.user.userId, keyId);
    if (!revoked) {
      const deleted = await deleteRevokedSubsonicApiKey(req.user.userId, keyId);
      if (!deleted) return res.status(404).json({ error: 'API key not found' });
      return res.json({ status: 'deleted' });
    }
    res.json({ status: 'revoked' });
  } catch (error) {
    console.error('Subsonic key delete error:', error);
    res.status(500).json({ error: 'Failed to update API key' });
  }
});

// Delete account
router.delete('/delete-account', authAccountMutationRateLimit, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password required to delete account' });

    const user = await getUserByUsername(req.user.username);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Incorrect password' });

    // Don't allow deleting the last admin
    if (user.role === 'admin') {
      const { listUsers } = await import('../database');
      const users = await listUsers();
      const adminCount = users.filter((u: any) => u.role === 'admin').length;
      if (adminCount <= 1) {
        return res.status(400).json({ error: 'Cannot delete the last admin account' });
      }
    }

    await deleteUser(user.id);
    res.json({ status: 'deleted' });
  } catch (error) {
    console.error('Account deletion error:', error);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

// Validate invite token — returns rich metadata for the registration UI
router.get('/invites/:token/validate', inviteValidationRateLimit, async (req, res) => {
  try {
    const token = req.params.token as string;
    const invite = await getInvite(token);

    if (!invite) {
      return res.json({ valid: false, reason: 'not_found' });
    }

    // Check expiry
    if (invite.expires_at) {
      const expiresAt = typeof invite.expires_at === 'string'
        ? parseInt(invite.expires_at, 10)
        : Number(invite.expires_at);
      if (Date.now() > expiresAt) {
        return res.json({ valid: false, reason: 'expired' });
      }
    }

    // Check use limit
    if (Number(invite.uses) >= Number(invite.max_uses)) {
      return res.json({ valid: false, reason: 'used_up' });
    }

    // Resolve inviter username
    let inviterUsername: string | null = null;
    if (invite.created_by) {
      try {
        const inviter = await getUserById(invite.created_by);
        inviterUsername = inviter?.username ?? null;
      } catch (_) {
        // Non-fatal — proceed without inviter name
      }
    }

    res.json({
      valid: true,
      inviterUsername,
      expiresAt: invite.expires_at ? Number(invite.expires_at) : null,
      usesLeft: Number(invite.max_uses) - Number(invite.uses),
    });
  } catch (error) {
    res.json({ valid: false, reason: 'error' });
  }
});

export default router;
