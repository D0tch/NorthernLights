import React from 'react';
import { Routes, Route, Navigate, NavLink, useLocation } from 'react-router-dom';
import { PlaylistSidebar } from './components/PlaylistSidebar';
import PlayerShell from './components/PlayerShell';
import MobileMiniPlayer from './components/MobileMiniPlayer';
import { usePlayerPlacement } from './hooks/usePlayerPlacement';
import MobileBottomTabs from './components/MobileBottomTabs';
import CastHealthToasts from './components/cast/CastHealthToasts';
import KeyboardHint from './components/KeyboardHint';
import { usePlayerStore } from './store/index';
import { UserMenu } from './components/UserMenu';
import { Settings as SettingsIcon, AudioWaveform, RefreshCw } from 'lucide-react';
import { ToastContainer } from './components/ToastContainer';
import { useOnlineStatus } from './hooks/useOnlineStatus';
import { useSSE } from './hooks/useSSE';
import { useToast } from './hooks/useToast';
import { playbackManager } from './utils/PlaybackManager';
import { GlobalScanningIndicator } from './components/GlobalScanningIndicator';
import { applyPendingPwaUpdate } from './utils/pwaUpdate';

const LibraryHome = React.lazy(() => import('./components/library/LibraryHome').then(module => ({ default: module.LibraryHome })));
const AlbumDetail = React.lazy(() => import('./components/library/AlbumDetail').then(module => ({ default: module.AlbumDetail })));
const ArtistDetail = React.lazy(() => import('./components/library/ArtistDetail').then(module => ({ default: module.ArtistDetail })));
const GenreDetail = React.lazy(() => import('./components/library/GenreDetail').then(module => ({ default: module.GenreDetail })));
const PlaylistDetail = React.lazy(() => import('./components/library/PlaylistDetail').then(module => ({ default: module.PlaylistDetail })));
const SetupWizard = React.lazy(() => import('./components/SetupWizard').then(module => ({ default: module.SetupWizard })));
const LoginPage = React.lazy(() => import('./components/LoginPage').then(module => ({ default: module.LoginPage })));
const Hub = React.lazy(() => import('./components/Hub').then(module => ({ default: module.Hub })));
const Playlists = React.lazy(() => import('./components/library/Playlists').then(module => ({ default: module.Playlists })));
const GlobalSearch = React.lazy(() => import('./components/GlobalSearch').then(module => ({ default: module.GlobalSearch })));
const SettingsModal = React.lazy(() => import('./components/SettingsModal').then(module => ({ default: module.SettingsModal })));
const InviteRegister = React.lazy(() => import('./components/InviteRegister').then(module => ({ default: module.InviteRegister })));
const TrackContextMenu = React.lazy(() => import('./components/library/TrackContextMenu').then(module => ({ default: module.TrackContextMenu })));
const DatabaseControl = React.lazy(() => import('./components/DatabaseControl').then(module => ({ default: module.DatabaseControl })));

const TAB_CONFIG = [
  { path: '/library', label: 'Hub', end: true },
  { path: '/playlists', label: 'Playlists' },
  { path: '/library/artists', label: 'Artists' },
  { path: '/library/albums', label: 'Albums' },
  { path: '/library/genres', label: 'Genres' },
];

const FullPageFallback: React.FC<{ label?: string }> = ({ label = 'Loading...' }) => (
  <div className="h-screen w-full flex flex-col items-center justify-center bg-[var(--color-bg-primary)] text-[var(--color-text-primary)]">
    <div className="w-12 h-12 border-4 border-[var(--color-primary)]/20 border-t-[var(--color-primary)] rounded-full animate-spin" />
    <p className="mt-4 text-sm text-[var(--color-text-secondary)]">{label}</p>
  </div>
);

const RouteFallback: React.FC = () => (
  <div className="page-container">
    <div className="h-8 w-32 rounded bg-[var(--color-surface-variant)] animate-pulse mb-2" />
    <div className="h-4 w-48 rounded bg-[var(--color-surface-variant)] animate-pulse mb-8" />
    <div className="album-grid">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex flex-col animate-pulse">
          <div className="aspect-square w-full mb-3 rounded-2xl bg-[var(--color-surface-variant)]" />
          <div className="px-1 space-y-1.5">
            <div className="h-4 w-3/4 rounded bg-[var(--color-surface-variant)]" />
            <div className="h-3 w-1/2 rounded bg-[var(--color-surface-variant)]" />
          </div>
        </div>
      ))}
    </div>
  </div>
);

const SearchFallback: React.FC = () => (
  <div className="h-9 w-[104px] flex-shrink-0 rounded-full border border-black/10 dark:border-white/15 bg-black/10 dark:bg-white/10" />
);

const GlobalSearchSlot: React.FC = () => (
  <React.Suspense fallback={<SearchFallback />}>
    <GlobalSearch />
  </React.Suspense>
);

let authExpirationFetchInterceptorInstalled = false;

const isProtectedApiRequest = (input: RequestInfo | URL): boolean => {
  const rawUrl = input instanceof Request ? input.url : input.toString();
  let url: URL;
  try {
    url = new URL(rawUrl, window.location.origin);
  } catch {
    return false;
  }

  if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) return false;
  if (
    url.pathname === '/api/auth/login' ||
    url.pathname === '/api/auth/register' ||
    url.pathname === '/api/setup/status' ||
    url.pathname === '/api/setup/complete' ||
    url.pathname === '/api/health' ||
    url.pathname.startsWith('/api/invites/') ||
    url.pathname === '/api/providers/external/proxy-image'
  ) {
    return false;
  }

  return true;
};

const installAuthExpirationFetchInterceptor = () => {
  if (authExpirationFetchInterceptorInstalled || typeof window === 'undefined') return;
  authExpirationFetchInterceptorInstalled = true;
  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await originalFetch(input, init);
    if (
      response.status === 401 &&
      isProtectedApiRequest(input) &&
      usePlayerStore.getState().authToken
    ) {
      usePlayerStore.getState().expireAuthSession();
    }
    return response;
  };
};

const App: React.FC = () => {
  const [isSettingsOpen, setIsSettingsOpen] = React.useState(false);
  const [dbConnected, _setDbConnected] = React.useState<boolean | null>(null);
  const dbConnectedRef = React.useRef<boolean | null>(null);
  
  const setDbConnected = React.useCallback((val: boolean | null) => {
    dbConnectedRef.current = val;
    _setDbConnected(val);
  }, []);
  const [isDatabaseStarting, setIsDatabaseStarting] = React.useState(false);
  const library = usePlayerStore(state => state.library);
  const isLibraryLoading = usePlayerStore(state => state.isLibraryLoading);
  const needsSetup = usePlayerStore(state => state.needsSetup);
  const checkSetupStatus = usePlayerStore(state => state.checkSetupStatus);
  const authToken = usePlayerStore(state => state.authToken);
  const sseAccessToken = usePlayerStore(state => state.sseAccessToken);
  const authExpired = usePlayerStore(state => state.authExpired);
  const authExpiredMessage = usePlayerStore(state => state.authExpiredMessage);
  const authExpiredUsername = usePlayerStore(state => state.authExpiredUsername);
  const login = usePlayerStore(state => state.login);

  const [isScannerVisibleLocally, setIsScannerVisibleLocally] = React.useState(false);
  const isScanningGlobal = usePlayerStore(state => state.isScanning);
  const isSidebarCollapsed = usePlayerStore(state => state.isSidebarCollapsed);
  const playlist = usePlayerStore(state => state.playlist);
  const currentUser = usePlayerStore(state => state.currentUser);
  const isAdmin = currentUser?.role === 'admin';
  const [playerPlacement] = usePlayerPlacement();

  // Auto-show scanner toast when a scan starts
  React.useEffect(() => {
    if (isScanningGlobal) setIsScannerVisibleLocally(true);
  }, [isScanningGlobal]);

  // Initialize AudioContext on first user interaction (Safari requires this)
  React.useEffect(() => {
    const initAudio = () => {
      playbackManager.ensureAudioContext();
    };
    document.addEventListener('click', initAudio, { once: true });
    document.addEventListener('touchstart', initAudio, { once: true });
    return () => {
      document.removeEventListener('click', initAudio);
      document.removeEventListener('touchstart', initAudio);
    };
  }, []);

  const continuityRestoreAttemptedRef = React.useRef(false);
  React.useEffect(() => {
    if (continuityRestoreAttemptedRef.current || needsSetup !== false || !authToken || dbConnected !== true) return;
    continuityRestoreAttemptedRef.current = true;
    window.setTimeout(() => {
      void playbackManager.restoreFromContinuitySnapshot();
    }, 500);
  }, [authToken, dbConnected, needsSetup]);

  const location = useLocation();

  // Health check function accessible from render
  const checkHealth = React.useCallback(async () => {
    try {
      const res = await fetch('/api/health');
      const data = await res.json();
      setDbConnected(data.dbConnected === true);
      return data.dbConnected === true;
    } catch {
      setDbConnected(false);
      return false;
    }
  }, []);

  // Determine which tab should be active based on current route
  const getActiveTab = (path: string): string => {
    if (path === '/library' || path === '/') return '/library';
    if (path.startsWith('/library/artist')) return '/library/artists';
    if (path.startsWith('/library/album')) return '/library/albums';
    if (path.startsWith('/library/genre')) return '/library/genres';
    if (path.startsWith('/playlists')) return '/playlists';
    return '/library';
  };
  const activeTab = getActiveTab(location.pathname);

  // Trigger an initial library fetch, apply theme, and subscribe to scan events
  React.useEffect(() => {
    installAuthExpirationFetchInterceptor();
    usePlayerStore.getState().setTheme(usePlayerStore.getState().theme);

    const performInitialChecks = async () => {
      const ok = await checkHealth();
      if (ok) {
        await checkSetupStatus();
        const { needsSetup, authToken } = usePlayerStore.getState();
        if (!needsSetup && authToken) {
          usePlayerStore.getState().loadSettings();
          usePlayerStore.getState().fetchLibraryFromServer();
          usePlayerStore.getState().fetchPlaylistsFromServer();
        }
      }
    };

    performInitialChecks();

    // Persistent health poller
    const interval = setInterval(async () => {
      const previouslyConnected = dbConnectedRef.current;
      const ok = await checkHealth();
      
      // Only trigger a sync if we just became healthy (transition from false to true)
      if (ok && previouslyConnected === false) {
        const { needsSetup } = usePlayerStore.getState();
        if (needsSetup === null) {
          await checkSetupStatus();
        }
        if (authToken) {
          usePlayerStore.getState().fetchLibraryFromServer();
          usePlayerStore.getState().fetchPlaylistsFromServer();
        }
      }
    }, 10000); // 10s is a good balance for background polling

    return () => clearInterval(interval);
  }, [checkSetupStatus, checkHealth]);

  React.useEffect(() => {
    if (!authToken || needsSetup) return;

    let cancelled = false;
    const validateSession = async () => {
      const token = usePlayerStore.getState().authToken;
      if (!token) return;
      try {
        const res = await fetch('/api/auth/me', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const data = await res.json().catch(() => null);
        if (!cancelled && data?.user) {
          usePlayerStore.setState({ currentUser: data.user });
        }
      } catch {
        // Network and database health are handled separately.
      }
    };

    validateSession();
    const interval = window.setInterval(validateSession, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [authToken, needsSetup]);

  // Connect to scan status SSE only when authenticated (EventSource can't send headers)
  const onSSEMessage = React.useCallback((data: any) => {
    const d = data as {
      isScanning: boolean;
      phase: 'idle' | 'walk' | 'metadata' | 'analysis';
      scannedFiles: number;
      totalFiles: number;
      activeWorkers: number;
      activeFiles: string[];
      currentFile: string;
      libraryChanged: boolean;
    };
    const wasScanning = usePlayerStore.getState().isScanning;
    usePlayerStore.getState().setIsScanning(
      d.isScanning,
      d.phase,
      d.scannedFiles,
      d.totalFiles,
      d.activeWorkers,
      d.activeFiles,
      d.currentFile
    );
    if (wasScanning && !d.isScanning && d.libraryChanged) {
      (async () => {
        await usePlayerStore.getState().fetchLibraryFromServer();
        await usePlayerStore.getState().fetchPlaylistsFromServer();
      })();
    }
  }, []);

  useSSE(
    !needsSetup && (sseAccessToken || authToken) ? `/api/library/scan/status?token=${encodeURIComponent(sseAccessToken || authToken || '')}` : null,
    { onMessage: onSSEMessage, throttleMs: 100 }
  );

  // Offline detection
  const isOnline = useOnlineStatus();
  const { addToast } = useToast();
  const prevOnlineRef = React.useRef(isOnline);
  const pendingUpdate = usePlayerStore(state => state.pendingUpdate);
  const playbackState = usePlayerStore(state => state.playbackState);

  React.useEffect(() => {
    if (prevOnlineRef.current !== isOnline) {
      if (!isOnline) {
        addToast('You are offline. Some features may be unavailable.', 'info');
      } else {
        addToast('Back online.', 'success');
      }
      prevOnlineRef.current = isOnline;
    }
  }, [isOnline, addToast]);

  // Surface MusicBrainz OAuth callback status from the redirect back to the app.
  // Lives at App level (not MetadataTab) so the outcome is visible regardless
  // of which route the user lands on after the redirect.
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get('mb_connected');
    const error = params.get('mb_error');
    if (!connected && !error) return;
    if (connected) {
      addToast('MusicBrainz connected successfully', 'success');
      usePlayerStore.getState().loadSettings();
    } else if (error) {
      addToast(`MusicBrainz authorization failed: ${error}`, 'error');
    }
    params.delete('mb_connected');
    params.delete('mb_error');
    const query = params.toString();
    const cleanUrl = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
    window.history.replaceState({}, '', cleanUrl);
  }, [addToast]);

  // Surface Last.fm OAuth callback status from the redirect back to the app.
  // This must live at App level rather than inside the settings account tab,
  // because the documented Last.fm web auth flow returns to the app root.
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get('lfm_connected');
    const error = params.get('lfm_error');
    if (!connected && !error) return;

    if (connected) {
      addToast('Last.fm connected successfully', 'success');
      usePlayerStore.getState().loadSettings();
    } else if (error) {
      addToast(`Last.fm authorization failed: ${error}`, 'error');
    }

    params.delete('lfm_connected');
    params.delete('lfm_error');
    const query = params.toString();
    const cleanUrl = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
    window.history.replaceState({}, '', cleanUrl);
  }, [addToast]);

  const handleApplyPwaUpdate = React.useCallback(() => {
    if (playbackState === 'playing') {
      playbackManager.persistContinuitySnapshot();
      addToast('Update ready. Pause playback before reloading.', 'info');
      return;
    }

    playbackManager.persistContinuitySnapshot();
    void applyPendingPwaUpdate();
  }, [addToast, playbackState]);

  const [folderPathInput, setFolderPathInput] = React.useState('');

  const isSidebarOpen = usePlayerStore((s) => s.isSidebarOpen);
  const setIsSidebarOpen = usePlayerStore((s) => s.setIsSidebarOpen);

  // Mobile bottom sheet touch handling
  const sidebarRef = React.useRef<HTMLDivElement>(null);
  const touchStartY = React.useRef<number>(0);
  const currentTranslateY = React.useRef<number>(0);
  const isDragging = React.useRef<boolean>(false);

  const handleTouchStart = React.useCallback((e: React.TouchEvent) => {
    touchStartY.current = e.touches[0].clientY;
    isDragging.current = true;
  }, []);

  const handleTouchMove = React.useCallback((e: React.TouchEvent) => {
    if (!isDragging.current || !sidebarRef.current) return;
    const touchY = e.touches[0].clientY;
    const deltaY = touchY - touchStartY.current;
    
    // Only allow dragging downward
    if (deltaY > 0) {
      currentTranslateY.current = deltaY;
      sidebarRef.current.style.transform = `translateY(${deltaY}px)`;
      sidebarRef.current.style.transition = 'none';
    }
  }, []);

  const handleTouchEnd = React.useCallback(() => {
    if (!sidebarRef.current) return;
    isDragging.current = false;
    
    const threshold = window.innerHeight * 0.3; // 30% of screen height
    if (currentTranslateY.current > threshold) {
      // Close the sidebar
      setIsSidebarOpen(false);
    } else {
      // Snap back to open
      sidebarRef.current.style.transform = '';
      sidebarRef.current.style.transition = '';
    }
    currentTranslateY.current = 0;
  }, [setIsSidebarOpen]);

  // Reset sidebar transform when opening/closing
  React.useEffect(() => {
    if (sidebarRef.current) {
      sidebarRef.current.style.transform = '';
      sidebarRef.current.style.transition = '';
    }
  }, [isSidebarOpen]);

  const handleDatabaseReady = React.useCallback(() => {
    setIsDatabaseStarting(true);
    setDbConnected(null);

    // Initial check
    checkHealth().then(ok => {
      if (ok) {
        setIsDatabaseStarting(false);
        checkSetupStatus();
        if (authToken) {
          usePlayerStore.getState().fetchLibraryFromServer();
          usePlayerStore.getState().fetchPlaylistsFromServer();
        }
        return;
      }

      // If not immediately ok, poll aggressively every 2s
      let attempts = 0;
      const interval = setInterval(async () => {
        attempts++;
        const healthy = await checkHealth();
        if (healthy || attempts > 15) {
          clearInterval(interval);
          setIsDatabaseStarting(false);
          if (healthy) {
            checkSetupStatus();
            if (authToken) {
              usePlayerStore.getState().fetchLibraryFromServer();
              usePlayerStore.getState().fetchPlaylistsFromServer();
            }
          } else {
            // If still not healthy after 30s, go back to recovery UI
            setDbConnected(false);
          }
        }
      }, 2000);
    });
  }, [checkHealth, checkSetupStatus, authToken]);

  // If database is not connected, show the control panel immediately
  if (dbConnected === false && !isDatabaseStarting) {
    return (
      <React.Suspense fallback={<FullPageFallback label="Loading database tools..." />}>
        <DatabaseControl
          onReady={handleDatabaseReady}
        />
      </React.Suspense>
    );
  }

  // Loading / Initializing gate
  // Shows if: 
  // 1. We are explicitly starting the database
  // 2. We don't know the connection status yet
  // 3. We are connected but don't know the setup status yet
  if (isDatabaseStarting || dbConnected === null || (dbConnected === true && needsSetup === null)) {
      const showStartingLabel = isDatabaseStarting;
      const showConnectingLabel = dbConnected === null;
      const showSetupLabel = dbConnected === true && needsSetup === null;

      return (
        <div className="h-screen w-full flex flex-col items-center justify-center bg-[var(--color-bg-primary)]">
          <div className="flex flex-col items-center space-y-6">
            <div className="relative">
              <div className="w-16 h-16 border-4 border-[var(--color-primary)]/20 border-t-[var(--color-primary)] rounded-full animate-spin" />
              <div className="absolute inset-x-0 -bottom-1 w-full h-1 bg-[var(--color-primary)]/10 blur-md" />
            </div>
            <div className="text-center">
              <h1 className="text-xl font-bold text-[var(--color-text-primary)]">
                {showStartingLabel ? 'Establishing Database Connection...' : 
                 showConnectingLabel ? 'Connecting to Server...' :
                 'Initializing Application...'}
              </h1>
              <p className="text-sm text-[var(--color-text-secondary)] mt-2">
                {showStartingLabel ? 'The database is booting up, this may take a few seconds.' : 
                 showConnectingLabel ? 'Verifying server and database health.' :
                 'Checking application setup status.'}
              </p>
            </div>
          </div>
        </div>
      );
  }

  if (needsSetup) {
      return <React.Suspense fallback={<FullPageFallback label="Loading setup..." />}>
        <SetupWizard onComplete={() => checkSetupStatus().then(() => {
          usePlayerStore.getState().fetchLibraryFromServer();
          usePlayerStore.getState().fetchPlaylistsFromServer();
        })} />
      </React.Suspense>;
  }

  if (!authToken) {
      // Invite registration doesn't require auth
      if (location.pathname.startsWith('/invite/')) {
          return (
            <React.Suspense fallback={<FullPageFallback label="Loading invite..." />}>
              <InviteRegister />
            </React.Suspense>
          );
      }

      const handleLogin = async (username: string, password: string) => {
          const success = await login(username, password);
          if (success) {
              usePlayerStore.getState().loadSettings();
              usePlayerStore.getState().fetchLibraryFromServer();
              usePlayerStore.getState().fetchPlaylistsFromServer();
          }
          return success;
      };
      return (
        <React.Suspense fallback={<FullPageFallback label="Loading sign in..." />}>
          <LoginPage
            onLogin={handleLogin}
            initialUsername={authExpiredUsername}
            sessionMessage={authExpired ? authExpiredMessage : null}
            submitLabel={authExpired ? 'Log in again' : 'Sign in'}
          />
        </React.Suspense>
      );
  }

  return (
    <>
      <div className="app-backdrop" aria-hidden="true" />
      <React.Suspense fallback={null}>
        <TrackContextMenu />
      </React.Suspense>
      {/* Global Scanning Indicator (admin only) */}
      {isAdmin && isScanningGlobal && isScannerVisibleLocally && (
        <GlobalScanningIndicator onClose={() => setIsScannerVisibleLocally(false)} />
      )}

      <div className="flex h-screen relative z-10 overflow-hidden text-[var(--color-text-primary)]">


        <main className="flex-1 flex flex-col min-w-0 relative">
          
          {/* Mobile Header (Hidden on Desktop) */}
          <div className="md:hidden px-4 pt-[max(0.75rem,var(--safe-area-top))] pb-3 flex items-center justify-between border-b border-[var(--glass-border)] bg-[var(--glass-bg)] backdrop-blur-md">
            <AudioWaveform size={22} className="text-[var(--color-primary)]" />
            <div className="flex items-center gap-1">
              {isAdmin && isScanningGlobal && (
                <button
                  onClick={() => setIsScannerVisibleLocally(v => !v)}
                  className="scan-indicator-btn scan-indicator-btn--dot-only"
                  title={isScannerVisibleLocally ? 'Hide scan progress' : 'Show scan progress'}
                >
                  <div className="scan-indicator-dot" />
                </button>
              )}
              <GlobalSearchSlot />
              <UserMenu onOpenSettings={() => setIsSettingsOpen(true)} />
            </div>
          </div>

          <div className="hidden md:flex items-center flex-none gap-3 overflow-x-auto hide-scrollbar z-20 w-full py-3 px-4 md:px-8 lg:px-12">
            {TAB_CONFIG.map(tab => {
                const isActive = activeTab === tab.path;
                return (
                    <NavLink
                        key={tab.path}
                        to={tab.path}
                        end={tab.end}
                        className={({ isActive }) => `
                            capitalize font-semibold text-sm px-5 py-2 rounded-full
                            border backdrop-blur-md whitespace-nowrap
                            transition-ui duration-200 cursor-pointer
                            active:scale-95 no-underline
                            ${isActive
                                ? 'btn-aurora shadow-aurora'
                                : 'text-[var(--color-text-secondary)] border-[var(--color-border)] bg-black/5 dark:bg-white/[0.06] hover:bg-black/10 dark:hover:bg-white/[0.12] hover:text-[var(--color-text-primary)] hover:border-[var(--glass-border-hover)]'
                            }
                        `}
                    >
                        {tab.label}
                    </NavLink>
                );
            })}
            <div className="flex items-center gap-2 ml-auto">
              <GlobalSearchSlot />
              <UserMenu onOpenSettings={() => setIsSettingsOpen(true)} />
              {isAdmin && isScanningGlobal && (
                <button
                  onClick={() => setIsScannerVisibleLocally(v => !v)}
                  className="scan-indicator-btn"
                  title={isScannerVisibleLocally ? 'Hide scan progress' : 'Show scan progress'}
                >
                  <div className="scan-indicator-dot" />
                  <span>Scanning</span>
                </button>
              )}
              <button
                onClick={() => setIsSettingsOpen(true)}
                className="p-2 rounded-full text-[var(--color-text-secondary)] bg-black/5 dark:bg-white/[0.06] hover:text-[var(--color-text-primary)] hover:bg-black/10 dark:hover:bg-white/[0.12] transition-ui duration-300 border border-[var(--color-border)] hover:border-[var(--glass-border-hover)] flex-shrink-0"
                title="Settings"
              >
                <SettingsIcon className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Main Content Area (Routing) */}
          <div className="flex-1 flex overflow-hidden">
            <div className={`flex-1 overflow-y-auto ${
              playlist.length > 0
                ? playerPlacement === 'dock'
                  ? 'pb-32 md:pb-24'
                  : 'pb-32 md:pb-44'
                : 'pb-16 md:pb-4'
            }`}>
              {library.length === 0 ? (
                isLibraryLoading && location.pathname !== '/library' ? (
                  <div className="page-container">
                    <div className="h-8 w-32 rounded bg-[var(--color-surface-variant)] animate-pulse mb-2" />
                    <div className="h-4 w-48 rounded bg-[var(--color-surface-variant)] animate-pulse mb-8" />
                    <div className="album-grid">
                      {Array.from({ length: 12 }).map((_, i) => (
                        <div key={i} className="flex flex-col animate-pulse">
                          <div className="aspect-square w-full mb-3 rounded-2xl bg-[var(--color-surface-variant)]" />
                          <div className="px-1 space-y-1.5">
                            <div className="h-4 w-3/4 rounded bg-[var(--color-surface-variant)]" />
                            <div className="h-3 w-1/2 rounded bg-[var(--color-surface-variant)]" />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                <React.Suspense fallback={<RouteFallback />}>
                  <Routes>
                    <Route path="/invite/:token" element={<InviteRegister />} />
                    <Route path="*" element={
                      <div className="empty-state font-body flex flex-col items-center justify-center p-8 flex-1">
                        <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-transparent bg-clip-text bg-gradient-to-br from-[var(--aurora-green)] to-[var(--color-primary)] mb-4">
                          NorthernLights
                        </h1>
                        <p className="text-lg text-[var(--color-text-secondary)] mb-8 max-w-md text-center">
                          Provide the absolute path to your local music directory to let the host scan and stream it.
                        </p>
                        <div className="flex flex-col md:flex-row gap-4 w-full max-w-lg">
                          <input
                            type="text"
                            placeholder="/home/andreas/Music"
                            value={folderPathInput}
                            onChange={(e) => setFolderPathInput(e.target.value)}
                            className="flex-1 px-4 py-3 rounded-full border border-[var(--glass-border)] bg-[var(--glass-bg)] backdrop-blur-md text-[var(--color-text-primary)] shadow-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent transition-ui duration-300"
                            disabled={isScanningGlobal}
                          />
                          <button
                            onClick={async () => {
                              if (!folderPathInput.trim()) return;
                              await usePlayerStore.getState().addLibraryFolder(folderPathInput.trim());
                              setFolderPathInput('');
                            }}
                            className="btn btn-lg whitespace-nowrap"
                            disabled={isScanningGlobal || !folderPathInput.trim()}
                          >
                            {isScanningGlobal ? '✦ Scanning...' : '✦ Map Folder'}
                          </button>
                        </div>
                      </div>
                    } />
                  </Routes>
                </React.Suspense>
                )
              ) : (
                <React.Suspense fallback={<RouteFallback />}>
                  <Routes>
                    <Route path="/" element={<Navigate to="/library" replace />} />
                    <Route path="/invite/:token" element={<InviteRegister />} />
                    <Route path="/library" element={<Hub />} />
                    <Route path="/library/artists" element={<LibraryHome section="artists" />} />
                    <Route path="/library/artist/:artistId" element={<ArtistDetail />} />
                    <Route path="/library/albums" element={<LibraryHome section="albums" />} />
                    <Route path="/library/album/:albumId" element={<AlbumDetail />} />
                    <Route path="/library/genres" element={<LibraryHome section="genres" />} />
                    <Route path="/library/genre/:genreId" element={<GenreDetail />} />
                    <Route path="/playlists" element={<Playlists />} />
                    <Route path="/playlists/:playlistId" element={<PlaylistDetail />} />
                    <Route path="*" element={<Navigate to="/library" replace />} />
                  </Routes>
                </React.Suspense>
              )}
            </div>
          </div>

          <CastHealthToasts />

          {/* Desktop Playback Surface — floats or docks based on user preference */}
          {playlist.length > 0 && (
            <div className="hidden md:block">
              <PlayerShell />
            </div>
          )}

          {/* Mobile Mini Player */}
          {playlist.length > 0 && <MobileMiniPlayer />}

          {/* Mobile Bottom Tabs */}
          <MobileBottomTabs />

          {/* Keyboard Hint Overlay */}
          <KeyboardHint />
        </main>

        {isSettingsOpen && (
          <React.Suspense fallback={null}>
            <SettingsModal onClose={() => setIsSettingsOpen(false)} />
          </React.Suspense>
        )}

        <ToastContainer />

        {/* PWA Update Available Banner */}
        {pendingUpdate && (
          <div className="fixed bottom-6 left-6 z-[10001] flex items-center gap-3 px-5 py-3.5 rounded-2xl border shadow-2xl backdrop-blur-xl bg-[var(--glass-bg)] border-[var(--color-primary)]/30 max-w-[360px]">
            <div className="flex-1">
              <p className="text-sm font-medium text-[var(--color-text-primary)]">Update Available</p>
              <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">Reload to get the latest version.</p>
            </div>
            <button
              onClick={handleApplyPwaUpdate}
              className="btn btn-primary btn-sm flex items-center gap-1.5"
            >
              <RefreshCw size={14} />
              Reload
            </button>
          </div>
        )}

        {/* Mobile Sidebar Overlay Backdrop */}
        {isSidebarOpen && (
           <div 
              className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40 md:hidden transition-opacity" 
              onClick={() => setIsSidebarOpen(false)} 
            />
        )}
        
        {/* Sidebar Container - Mobile Bottom Sheet / Desktop Right Panel */}
        <div 
          ref={sidebarRef}
          className={`sidebar-bottom-sheet fixed z-50 w-full ${isSidebarCollapsed ? 'md:w-24' : 'md:w-96'} transform transition-[width,transform] duration-300 ease-in-out md:relative md:translate-x-0 border-l border-[var(--glass-border)] ${isSidebarOpen ? 'translate-y-0' : 'translate-y-full md:translate-y-0'}`}
        >
          {/* Drag Handle - Mobile Only */}
          <div 
            className="sidebar-handle md:hidden"
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
          >
            <div className="w-10 h-1 rounded-full bg-[var(--color-text-muted)] opacity-40" />
          </div>
          <div className="h-full overflow-hidden">
            <PlaylistSidebar />
          </div>
        </div>
      </div>
    </>
  );
};

export default App;
