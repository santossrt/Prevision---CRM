export const themeModes = ["system", "light", "dark"] as const;
export type ThemeMode = typeof themeModes[number];
export interface UserPreferenceDTO { theme: ThemeMode; version: number }
