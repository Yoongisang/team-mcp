import type { NotionClient } from "./notion.js";

export const DEFAULT_LOCK_TTL_SECONDS = 300;

export interface AcquiredLock {
  id: string;
  expiresAt: string;
}

export class NotionLock {
  constructor(
    private readonly notion: NotionClient,
    private readonly databaseId: string,
  ) {}

  async acquire(ttlSeconds = DEFAULT_LOCK_TTL_SECONDS): Promise<AcquiredLock> {
    const active = await this.notion.findActiveLock(this.databaseId);
    if (active) {
      throw new Error(
        `다른 처리 진행 중 (활성 락 만료: ${active.expires_at}). 잠시 후 재시도하라.`,
      );
    }
    return this.notion.createLock(this.databaseId, ttlSeconds);
  }

  async release(lockId: string): Promise<void> {
    await this.notion.archivePage(lockId);
  }
}
