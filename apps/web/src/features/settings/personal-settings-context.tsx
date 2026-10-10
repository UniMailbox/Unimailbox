import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
  type ReactElement,
} from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_PERSONAL_PREFERENCES,
  personalSettingsSchema,
  type PersonalSettings,
  type PersonalPreferences,
} from '@unimailbox/contracts';
import { useApiClient } from '../../infrastructure/api/client-provider';
import { useAuthSession } from '../auth/auth-session-store';
import { setLanguage } from '../../infrastructure/i18n/locale';
import { applyTheme } from '../../components/ThemeSwitch';
import { ApiError } from '../../infrastructure/api/errors';
const defaults: PersonalSettings = {
  preferences: DEFAULT_PERSONAL_PREFERENCES,
  avatarVersion: null,
  avatarContentType: null,
};
interface SettingsContextValue {
  settings: PersonalSettings;
  avatarUrl: string | undefined;
  loading: boolean;
  busy: boolean;
  error: unknown;
  retry: () => void;
  update: (patch: Partial<PersonalPreferences>) => Promise<void>;
  avatar: (file: File | null) => Promise<void>;
}
const SettingsContext = createContext<SettingsContextValue>({
  settings: defaults,
  avatarUrl: undefined,
  loading: false,
  busy: false,
  error: null,
  retry: () => {},
  update: async () => {},
  avatar: async () => {},
});
export function usePersonalSettings(): SettingsContextValue {
  return useContext(SettingsContext);
}
export function PersonalSettingsProvider({ children }: { children: ReactNode }): ReactElement {
  const session = useAuthSession((state) => state.session);
  return (
    <UserSettings
      key={session?.userId ?? 'anonymous'}
      userId={session?.userId}
      enabled={!!session && !session.mustChangePassword}
    >
      {children}
    </UserSettings>
  );
}
function UserSettings({
  userId,
  enabled,
  children,
}: {
  userId: string | undefined;
  enabled: boolean;
  children: ReactNode;
}): ReactElement {
  const api = useApiClient();
  const client = useQueryClient();
  const key = ['personal-settings', userId];
  const query = useQuery({
    queryKey: key,
    enabled,
    queryFn: async () => {
      const response = await api.fetch<{ data: unknown }>('/api/v1/auth/me/preferences');
      const parsed = personalSettingsSchema.safeParse(response.data);
      if (!parsed.success) throw new ApiError('INVALID_RESPONSE', 'Invalid settings response', 502);
      return parsed.data;
    },
  });
  const settings = query.data ?? defaults;
  const theme = settings.preferences.theme;
  useEffect(() => {
    if (!query.data) return;
    setLanguage(query.data.preferences.language);
    applyTheme(theme);
    document.documentElement.dataset.density = query.data.preferences.density;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = (): void => applyTheme(theme);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query.data, theme]);
  useEffect(
    () => () => {
      document.documentElement.removeAttribute('data-density');
    },
    [],
  );
  const mutation = useMutation({
    mutationFn: async (request: { patch?: Partial<PersonalPreferences>; file?: File | null }) => {
      const result = await api.fetch<{ data: unknown }>(
        request.patch ? '/api/v1/auth/me/preferences' : '/api/v1/auth/me/avatar',
        request.patch
          ? { method: 'PATCH', body: request.patch }
          : request.file
            ? { method: 'POST', body: request.file, headers: { 'Content-Type': request.file.type } }
            : { method: 'DELETE' },
      );
      return personalSettingsSchema.parse(result.data);
    },
    onSuccess: (value) => {
      client.setQueryData(key, value);
    },
  });
  const avatarQuery = useQuery({
    queryKey: ['personal-avatar', userId, settings.avatarVersion],
    enabled: enabled && !!settings.avatarVersion,
    queryFn: async () =>
      api.fetch<ArrayBuffer>('/api/v1/auth/me/avatar', { responseType: 'arrayBuffer' }),
  });
  const [avatarUrl, setAvatarUrl] = useState<string>();
  useEffect(() => {
    setAvatarUrl(undefined);
    if (!avatarQuery.data || !settings.avatarVersion || !settings.avatarContentType) return;
    const url = URL.createObjectURL(
      new Blob([avatarQuery.data], { type: settings.avatarContentType }),
    );
    setAvatarUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [avatarQuery.data, settings.avatarVersion, settings.avatarContentType]);
  return (
    <SettingsContext.Provider
      value={{
        settings,
        avatarUrl,
        loading: enabled && query.isPending,
        busy: mutation.isPending,
        error: query.error ?? mutation.error ?? avatarQuery.error,
        retry: () => {
          mutation.reset();
          void query.refetch();
          if (settings.avatarVersion) void avatarQuery.refetch();
        },
        update: async (patch) => {
          await mutation.mutateAsync({ patch });
        },
        avatar: async (file) => {
          await mutation.mutateAsync({ file });
        },
      }}
    >
      {children}
    </SettingsContext.Provider>
  );
}
