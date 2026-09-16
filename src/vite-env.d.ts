/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ANSWER_PROVIDER?: 'mock' | 'claude';
  /**
   * Opt-in flag for the HVAC fixture. Vite inlines `import.meta.env.*` as
   * string literals at build time, so this is read as a plain string
   * ("true"/"false"/undefined), never as a boolean — compare with `=== 'true'`.
   * Unset (the default) means no demo data and no bootstrap call at all, so a
   * production build with no env file behaves like a brand-new real tenant.
   */
  readonly VITE_DEMO_MODE?: string;
}
