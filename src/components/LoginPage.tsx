import React, { useState, useRef } from 'react';
import { Music2, Eye, EyeOff, Loader2, LogIn } from 'lucide-react';

interface LoginPageProps {
  onLogin: (username: string, password: string) => Promise<boolean>;
  initialUsername?: string;
  sessionMessage?: string | null;
  submitLabel?: string;
}

export const LoginPage: React.FC<LoginPageProps> = ({
  onLogin,
  initialUsername = '',
  sessionMessage = null,
  submitLabel = 'Sign in',
}) => {
  const [username, setUsername] = useState(initialUsername);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) return;
    setIsLoading(true);
    setError('');
    const success = await onLogin(username.trim(), password);
    if (!success) {
      setError('Incorrect credentials. Ask your admin to reset your password.');
    }
    setIsLoading(false);
  };

  return (
    <div className="fixed inset-0 z-[100] bg-[var(--color-bg-primary)] flex items-center justify-center p-4 overflow-y-auto">
      {/* Aurora atmosphere — matches app-backdrop */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="app-backdrop" />
        <div className="aurora-background" />
      </div>

      <div className="auth-card-enter relative z-10 w-full max-w-sm bg-[var(--glass-bg)] border border-[var(--glass-border)] shadow-2xl rounded-3xl p-8 backdrop-blur-3xl my-auto">
        {/* Header */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-14 h-14 bg-[var(--color-primary)]/20 text-[var(--color-primary)] rounded-full flex items-center justify-center mb-4">
            <Music2 className="w-7 h-7" />
          </div>
          <h1 className="text-2xl font-extrabold tracking-tight text-[var(--color-text-primary)]"
              style={{ fontFamily: 'var(--font-display)' }}>
            Aurora
          </h1>
          <p className="text-sm text-[var(--color-text-muted)] mt-1">
            your library
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          {/* Username */}
          <div>
            <label htmlFor="login-username" className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1">
              Username
            </label>
            <input
              id="login-username"
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); passwordRef.current?.focus(); } }}
              placeholder="username"
              autoFocus
              autoComplete="username"
              className="w-full bg-[var(--color-surface)] border border-[var(--glass-border)] rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/50 transition-ui text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)]"
            />
          </div>

          {/* Password */}
          <div>
            <label htmlFor="login-password" className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1">
              Password
            </label>
            <div className="relative">
              <input
                id="login-password"
                ref={passwordRef}
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
                className="w-full bg-[var(--color-surface)] border border-[var(--glass-border)] rounded-xl px-4 py-3 pr-11 focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/50 transition-ui text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)]"
              />
              <button
                type="button"
                onClick={() => setShowPassword(v => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                className="btn-icon absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8"
              >
                {showPassword
                  ? <EyeOff className="w-4 h-4" />
                  : <Eye className="w-4 h-4" />
                }
              </button>
            </div>
          </div>

          {sessionMessage && !error && (
            <div role="status" className="text-[var(--color-text-primary)] text-sm bg-[var(--color-primary)]/10 border border-[var(--color-primary)]/20 rounded-xl px-4 py-2">
              {sessionMessage}
            </div>
          )}

          {/* Error */}
          {error && (
            <div role="alert" className="text-[var(--color-error)] text-sm bg-[var(--color-error)]/10 border border-[var(--color-error)]/20 rounded-xl px-4 py-2">
              {error}
            </div>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={!username.trim() || !password || isLoading}
            className="btn btn-primary btn-lg w-full mt-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isLoading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                signing in…
              </>
            ) : (
              <>
                <LogIn className="w-4 h-4" aria-hidden="true" />
                {submitLabel}
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  );
};
