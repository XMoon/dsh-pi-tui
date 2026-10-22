/**
 * The minimal Host seams the Settings Models/Account DIRECT pages need while
 * they are MOUNTED.
 *
 * Phase 3C / C2-A mounts the selected direct page as soon as the category
 * rail selects it (the right column shows the real page at once), so a
 * harness that walks the rail needs these answers even when the case never
 * opens the page itself. The stubs report an empty, unavailable Host: no
 * provider, no stored record, no account, no authorization target.
 *
 * They answer ONLY the calls a page makes while it is on screen; a case that
 * exercises a Host behavior supplies its own seam.
 * @module @xmoon76/dsh-pi-tui/test/support/settings-direct-page-stubs
 */

/** The provider/credential/authorization/account seams, as separate groups so
 *  a harness can keep its own answer for one of them. */
export const SETTINGS_DIRECT_PAGE_STUBS = {
  providers: {
    available: () => false,
    listCredentialOptions: () => [] as readonly unknown[],
    readCatalog: () => ({ options: [] as readonly unknown[], profiles: [] as readonly unknown[] }),
    readProfile: (route: string) => ({ route, configured: false, displayName: route, models: [] as readonly string[] }),
    configGuide: () => ({ profilePatchPath: '/home/u/.dsh/profiles/pi-tui/cordis.patch.yml' }),
    writeProfile: async () => {},
    writeKeylessProfile: async () => ({ kind: 'written' as const }),
  },
  authorization: {
    available: () => false,
    listTargets: () => [] as readonly unknown[],
    begin: async () => ({ kind: 'unavailable' as const }),
    onEvent: () => () => {},
    respond: async () => {},
    cancel: async () => {},
  },
  credentials: {
    available: () => false,
    recordsSupported: () => false,
  },
  account: {
    available: () => false,
    getState: async () => { throw new Error('account unavailable') },
    getProfile: async () => null,
    getBalance: async () => null,
    watch: async function* () {},
    getCallbackOrigin: () => undefined,
    startSignIn: async () => { throw new Error('account unavailable') },
    cancelSignIn: async () => { throw new Error('account unavailable') },
    signOut: async () => { throw new Error('account unavailable') },
    hasRunningAccountTasks: () => false,
  },
} as const

/**
 * Complete a harness's own `config` with the direct-page seams. The harness
 * keeps its own answer for every group it already provides; only the missing
 * ones come from the stubs.
 */
export function settingsDirectPageConfig(config: Record<string, unknown>): Record<string, unknown> {
  const own = config as Partial<typeof SETTINGS_DIRECT_PAGE_STUBS>
  return {
    ...config,
    providers: { ...SETTINGS_DIRECT_PAGE_STUBS.providers, ...(own.providers ?? {}) },
    authorization: { ...SETTINGS_DIRECT_PAGE_STUBS.authorization, ...(own.authorization ?? {}) },
    credentials: { ...SETTINGS_DIRECT_PAGE_STUBS.credentials, ...(own.credentials ?? {}) },
    account: { ...SETTINGS_DIRECT_PAGE_STUBS.account, ...(own.account ?? {}) },
  }
}
