import { z } from 'zod';
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const personalPreferencesSchema = z
  .object({
    language: z.enum(['en', 'zh-CN']),
    theme: z.enum(['system', 'light', 'dark']),
    density: z.enum(['comfortable', 'compact']),
    readingPane: z.enum(['none', 'right', 'bottom']),
    defaultMailboxId: z.string().uuid().nullable(),
  })
  .strict();
export const updatePersonalPreferencesSchema = personalPreferencesSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0);
export type PersonalPreferences = z.infer<typeof personalPreferencesSchema>;
export const DEFAULT_PERSONAL_PREFERENCES: PersonalPreferences = {
  language: 'en',
  theme: 'system',
  density: 'comfortable',
  readingPane: 'none',
  defaultMailboxId: null,
};
export const personalSettingsSchema = z
  .object({
    preferences: personalPreferencesSchema,
    avatarVersion: z.string().uuid().nullable(),
    avatarContentType: z.enum(['image/png', 'image/jpeg', 'image/webp']).nullable(),
  })
  .strict();
export type PersonalSettings = z.infer<typeof personalSettingsSchema>;
