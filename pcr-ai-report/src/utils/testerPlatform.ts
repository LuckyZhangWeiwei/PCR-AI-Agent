/** Fixed platform filter options (Yield Monitor HOSTNAME). */
export const TESTER_PLATFORM_OPTIONS = [
  "J750",
  "FLEX",
  "UFLEX",
  "PS16",
  "MST",
  "93K",
] as const;

export type TesterPlatformOption = (typeof TESTER_PLATFORM_OPTIONS)[number];
