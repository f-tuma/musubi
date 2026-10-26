export type ProviderSyncOptions = {
  /** Limit a strict, user-triggered sync to one provider/account. */
  provider?: string;
  accountId?: string;
  /** Scheduled sync stays best-effort; connect flows fail loudly. */
  throwOnError?: boolean;
};

export type ProviderSyncFailure = {
  stage: "discovery" | "account";
  provider: string;
  accountId?: string;
  error: unknown;
};

type ProviderAccountSource = {
  provider: string;
  listAccounts(
    userID: string,
    accountId?: string,
    options?: { metadataOnly?: boolean },
  ): Promise<{ id: string; label: string }[]>;
};

/**
 * Provider/account fault boundary shared by scheduled and user-triggered sync.
 * It contains no database or logging dependencies, so failure and retry
 * semantics can be tested with deterministic fake adapters.
 */
export async function runProviderSyncs<TAdapter extends ProviderAccountSource>(
  adapters: readonly TAdapter[],
  userID: string,
  options: ProviderSyncOptions,
  hooks: {
    syncAccount(
      adapter: TAdapter,
      userID: string,
      account: { id: string; label: string },
    ): Promise<string[]>;
    onFailure(failure: ProviderSyncFailure): void;
    /** HTTP-bearing accounts are admitted by the shared coordinator later. */
    metadataOnly?: boolean;
    concurrent?: boolean;
  },
) {
  const changedCalendarIDs: string[] = [];
  const pending: Promise<string[]>[] = [];

  for (const adapter of adapters) {
    if (options.provider && adapter.provider !== options.provider) continue;

    let accounts: { id: string; label: string }[];
    try {
      accounts = await adapter.listAccounts(userID, options.accountId, { metadataOnly: hooks.metadataOnly });
    } catch (error) {
      hooks.onFailure({
        stage: "discovery",
        provider: adapter.provider,
        error,
      });
      if (options.throwOnError) throw error;
      continue;
    }

    if (
      options.accountId &&
      options.throwOnError &&
      !accounts.some((account) => account.id === options.accountId)
    ) {
      throw new Error("Connected account not found or not eligible for sync");
    }

    for (const account of accounts) {
      if (options.accountId && account.id !== options.accountId) continue;
      const run = async () => {
        try { return await hooks.syncAccount(adapter, userID, account); }
        catch (error) {
          hooks.onFailure({ stage: "account", provider: adapter.provider, accountId: account.id, error });
          if (options.throwOnError) throw error;
          return [];
        }
      };
      if (hooks.concurrent && !options.throwOnError) pending.push(run());
      else changedCalendarIDs.push(...await run());
    }
  }

  for (const changed of await Promise.all(pending)) changedCalendarIDs.push(...changed);
  return changedCalendarIDs;
}
