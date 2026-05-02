import { chunkForDiscord } from "./safety.js";

const API = "https://discord.com/api/v10";

export interface DiscordMessage {
  id: string;
  channel_id: string;
  content: string;
  author: { id: string; username: string };
  timestamp: string;
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
}
