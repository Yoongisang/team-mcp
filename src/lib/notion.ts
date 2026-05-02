const API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

export interface ActiveLock {
  id: string;
  expires_at: string;
}

export interface CreatedPage {
  id: string;
  url: string;
}

export class NotionClient {
  constructor(private readonly token: string) {}

  private async request(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<unknown> {
    const res = await fetch(`${API}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Notion API ${res.status} ${res.statusText}: ${body.slice(0, 300)}`,
      );
    }
    return await res.json();
  }

  async findActiveLock(
    databaseId: string,
    now: Date = new Date(),
  ): Promise<ActiveLock | null> {
    const data = (await this.request(`/databases/${databaseId}/query`, {
      method: "POST",
      body: {
        filter: {
          property: "expires_at",
          date: { after: now.toISOString() },
        },
        page_size: 1,
      },
    })) as { results?: Array<Record<string, unknown>> };

    const page = data.results?.[0];
    if (!page) return null;
    const props = (page.properties ?? {}) as Record<string, any>;
    const expiresAt = props.expires_at?.date?.start ?? "";
    return { id: String(page.id ?? ""), expires_at: String(expiresAt) };
  }

  async createLock(
    databaseId: string,
    ttlSeconds: number,
  ): Promise<{ id: string; expiresAt: string }> {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const data = (await this.request("/pages", {
      method: "POST",
      body: {
        parent: { database_id: databaseId },
        properties: {
          Name: { title: [{ text: { content: "lock" } }] },
          expires_at: { date: { start: expiresAt } },
        },
      },
    })) as { id: string };
    return { id: data.id, expiresAt };
  }

  async archivePage(pageId: string): Promise<void> {
    await this.request(`/pages/${pageId}`, {
      method: "PATCH",
      body: { archived: true },
    });
  }

  async createMeetingPage(
    parentPageId: string,
    title: string,
    body: string,
  ): Promise<CreatedPage> {
    const blocks = body
      .split("\n")
      .slice(0, 95)
      .map((line) => ({
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: line
            ? [{ type: "text", text: { content: line.slice(0, 1900) } }]
            : [],
        },
      }));

    const data = (await this.request("/pages", {
      method: "POST",
      body: {
        parent: { page_id: parentPageId },
        properties: {
          title: { title: [{ text: { content: title } }] },
        },
        children: blocks,
      },
    })) as { id: string; url: string };
    return { id: data.id, url: data.url };
  }
}
