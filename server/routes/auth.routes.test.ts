jest.mock('../database', () => ({}));
jest.mock('../services/auth.service', () => ({}));
jest.mock('../services/scopedToken.service', () => ({}));
jest.mock('../services/hubRefresh.service', () => ({}));
jest.mock('../middleware/auth', () => ({ requireAdmin: jest.fn() }));
jest.mock('../middleware/rateLimit', () => ({
  createRateLimiter: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { resolveSetupStatus } from './auth.routes';

describe('resolveSetupStatus', () => {
  it('starts a fresh installation at required account creation', () => {
    expect(resolveSetupStatus(false, null, null)).toEqual({
      needsSetup: true,
      adminCreated: false,
      onboardingCompleted: false,
      nextStep: 'account',
      dbConnected: true,
    });
  });

  it('keeps legacy installations complete when no onboarding flag exists', () => {
    expect(resolveSetupStatus(true, null, null)).toMatchObject({
      needsSetup: false,
      adminCreated: true,
      onboardingCompleted: true,
    });
  });

  it('resumes a newly created admin at the persisted step', () => {
    expect(resolveSetupStatus(true, false, 'library')).toMatchObject({
      needsSetup: true,
      adminCreated: true,
      onboardingCompleted: false,
      nextStep: 'library',
    });
  });

  it('falls back to analysis when persisted progress is invalid', () => {
    expect(resolveSetupStatus(true, false, 'unknown').nextStep).toBe('analysis');
  });
});
