import { chunkForDiscord } from "./safety.js";

const API = "https://discord.com/api/v10";

export interface DiscordMessage {
  id: string;
  channel_id: string;
  content: string;
  author: {
    id: string;
    username: string;
    global_name?: string | null;
    bot?: boolean;
  };
  member?: { nick?: string | null };
  timestamp: string;
}

/**
 * Discord에서 사람에게 보이는 이름을 반환한다.
 * 서버 별명 → 계정 표시 이름 → 사용자명 순으로 fallback 한다.
 */
export function discordDisplayName(message: DiscordMessage): string {
  return (
    message.member?.nick?.trim() ||
    message.author.global_name?.trim() ||
    message.author.username
  );
}

export interface ForumTag {
  id: string;
  name: string;
  moderated?: boolean;
  emoji_id?: string | null;
  emoji_name?: string | null;
}

export interface DiscordChannel {
  id: string;
  type: number;
  name?: string;
  parent_id?: string | null;
  guild_id?: string;
  applied_tags?: string[];
  available_tags?: ForumTag[];
}

export interface DiscordThread {
  id: string;
  name: string;
  parent_id: string;
  applied_tags?: string[];
  archived?: boolean;
  thread_metadata?: {
    archived?: boolean;
    archive_timestamp?: string;
  };
}

export class DiscordClient {
  constructor(private readonly token: string) {}

  private headers(): Record<string, string> {
    return {
      Authorization: `Bot ${this.token}`,
      "User-Agent": "team-mcp (https://github.com/yourteam/team-mcp, 0.1.0)",
    };
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        ...this.headers(),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(
        `Discord API ${res.status} ${res.statusText}: ${errBody.slice(0, 300)}`,
      );
    }
    return res;
  }

  async postMessage(
    channelId: string,
    content: string,
  ): Promise<DiscordMessage> {
    const res = await this.request("POST", `/channels/${channelId}/messages`, {
      content,
    });
    return (await res.json()) as DiscordMessage;
  }

  async postChunked(channelId: string, content: string): Promise<string[]> {
    const chunks = chunkForDiscord(content);
    const ids: string[] = [];
    for (const c of chunks) {
      const m = await this.postMessage(channelId, c);
      ids.push(m.id);
    }
    return ids;
  }

  async listMessages(
    channelId: string,
    opts: { limit?: number; before?: string; after?: string } = {},
  ): Promise<DiscordMessage[]> {
    const params = new URLSearchParams({
      limit: String(Math.min(opts.limit ?? 100, 100)),
    });
    if (opts.before) params.set("before", opts.before);
    if (opts.after) params.set("after", opts.after);
    const res = await this.request(
      "GET",
      `/channels/${channelId}/messages?${params}`,
    );
    return (await res.json()) as DiscordMessage[];
  }

  async listAllMessages(
    channelId: string,
    maxMessages = 1000,
  ): Promise<DiscordMessage[]> {
    const messages: DiscordMessage[] = [];
    let before: string | undefined;

    while (messages.length < maxMessages) {
      const limit = Math.min(100, maxMessages - messages.length);
      const batch = await this.listMessages(channelId, { limit, before });
      if (batch.length === 0) break;
      messages.push(...batch);
      before = batch[batch.length - 1]?.id;
      if (batch.length < limit) break;
    }

    return messages;
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    await this.request("DELETE", `/channels/${channelId}/messages/${messageId}`);
  }

  async bulkDelete(channelId: string, messageIds: string[]): Promise<void> {
    if (messageIds.length === 0) return;
    if (messageIds.length === 1) {
      await this.deleteMessage(channelId, messageIds[0]!);
      return;
    }
    await this.request(
      "POST",
      `/channels/${channelId}/messages/bulk-delete`,
      { messages: messageIds },
    );
  }

  async getChannel(channelId: string): Promise<DiscordChannel> {
    const res = await this.request("GET", `/channels/${channelId}`);
    return (await res.json()) as DiscordChannel;
  }

  /**
   * 포럼 채널에 새 스레드(게시글) 생성. content는 첫 메시지로 들어가며
   * Discord 한도(2000자)를 넘으면 첫 청크만 본문에 들어가고 나머지는 댓글로 추가된다.
   */
  async createForumThread(
    forumId: string,
    name: string,
    content: string,
    appliedTags: string[] = [],
  ): Promise<{ thread: DiscordThread; followupMessageIds: string[] }> {
    const chunks = chunkForDiscord(content);
    const first = chunks[0] ?? "";
    const rest = chunks.slice(1);

    const res = await this.request("POST", `/channels/${forumId}/threads`, {
      name,
      auto_archive_duration: 1440,
      applied_tags: appliedTags,
      message: { content: first },
    });
    const thread = (await res.json()) as DiscordThread;

    const followupMessageIds: string[] = [];
    for (const c of rest) {
      const m = await this.postMessage(thread.id, c);
      followupMessageIds.push(m.id);
    }
    return { thread, followupMessageIds };
  }

  /**
   * 길드 내 활성 스레드 목록을 조회한 뒤, 지정한 forumId를 parent로 가지는 것만 반환.
   * `prepare_meeting`과 `finish_meeting`에서 팀원 간 활성 [진행] 스레드를 찾기 위해 사용.
   *
   * Discord API: GET /guilds/{guild.id}/threads/active
   *   응답: { threads: Thread[], members: ThreadMember[] }
   *   봇이 접근 권한 있는 모든 활성 스레드를 반환.
   */
  async listActiveForumThreads(forumId: string): Promise<DiscordThread[]> {
    const forum = await this.getChannel(forumId);
    if (!forum.guild_id) {
      throw new Error(
        `포럼 채널 ${forumId}의 guild_id를 확인할 수 없어 활성 스레드 조회 불가.`,
      );
    }
    const res = await this.request(
      "GET",
      `/guilds/${forum.guild_id}/threads/active`,
    );
    const data = (await res.json()) as { threads: DiscordThread[] };
    return (data.threads ?? []).filter((t) => t.parent_id === forumId);
  }

  async listArchivedForumThreads(forumId: string): Promise<DiscordThread[]> {
    const res = await this.request(
      "GET",
      `/channels/${forumId}/threads/archived/public?limit=100`,
    );
    const data = (await res.json()) as { threads?: DiscordThread[] };
    return (data.threads ?? []).filter((t) => t.parent_id === forumId);
  }

  async listForumThreads(forumId: string): Promise<DiscordThread[]> {
    const [active, archived] = await Promise.all([
      this.listActiveForumThreads(forumId),
      this.listArchivedForumThreads(forumId),
    ]);
    return [...new Map([...active, ...archived].map((t) => [t.id, t])).values()];
  }

  async setThreadName(threadId: string, name: string): Promise<DiscordThread> {
    const res = await this.request("PATCH", `/channels/${threadId}`, { name });
    return (await res.json()) as DiscordThread;
  }

  async setThreadArchived(
    threadId: string,
    archived: boolean,
  ): Promise<DiscordThread> {
    const res = await this.request("PATCH", `/channels/${threadId}`, {
      archived,
    });
    return (await res.json()) as DiscordThread;
  }

  /**
   * 스레드에 적용된 태그 교체. 빈 배열이면 모든 태그 제거.
   */
  async setThreadTags(
    threadId: string,
    appliedTags: string[],
  ): Promise<DiscordThread> {
    const res = await this.request("PATCH", `/channels/${threadId}`, {
      applied_tags: appliedTags,
    });
    return (await res.json()) as DiscordThread;
  }

  /**
   * 메시지에 봇이 직접 reaction을 추가. 사용자가 클릭하기 쉽도록 미리 달아둘 때 사용.
   * emoji는 유니코드(예: "✅") 또는 커스텀 "name:id" 형식.
   */
  async addReaction(
    channelId: string,
    messageId: string,
    emoji: string,
  ): Promise<void> {
    const encoded = encodeURIComponent(emoji);
    await this.request(
      "PUT",
      `/channels/${channelId}/messages/${messageId}/reactions/${encoded}/@me`,
    );
  }

  /**
   * 특정 이모지로 reaction을 누른 사용자 목록을 반환.
   * 봇 자신의 reaction은 제외해서 반환한다 (Discord는 기본적으로 봇도 포함).
   */
  async getReactionUsers(
    channelId: string,
    messageId: string,
    emoji: string,
  ): Promise<Array<{ id: string; username: string; bot?: boolean }>> {
    const encoded = encodeURIComponent(emoji);
    const res = await this.request(
      "GET",
      `/channels/${channelId}/messages/${messageId}/reactions/${encoded}?limit=100`,
    );
    const users = (await res.json()) as Array<{
      id: string;
      username: string;
      bot?: boolean;
    }>;
    return users.filter((u) => !u.bot);
  }
}

/**
 * 포럼 채널의 available_tags에서 이름으로 ID 찾기. 없으면 명확한 에러.
 */
export function resolveForumTagIds(
  forum: DiscordChannel,
  names: string[],
): string[] {
  const available = forum.available_tags ?? [];
  return names.map((n) => {
    const found = available.find((t) => t.name === n);
    if (!found) {
      const have = available.map((t) => t.name).join(", ") || "(없음)";
      throw new Error(
        `포럼 태그 '${n}'를 찾을 수 없음. 포럼 채널(${forum.name ?? forum.id})의 ` +
          `사용 가능한 태그: ${have}. 포럼 설정에서 태그를 만들어주세요.`,
      );
    }
    return found.id;
  });
}
