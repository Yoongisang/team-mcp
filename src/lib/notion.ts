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

type RichText = {
  type: "text";
  text: { content: string };
  annotations?: Record<string, boolean>;
};

/** 인라인 마크다운(`code`, **bold**)을 RichText 배열로 변환 */
function parseInline(text: string): RichText[] {
  const result: RichText[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      result.push({ type: "text", text: { content: text.slice(last, m.index) } });
    }
    const raw = m[0]!;
    if (raw.startsWith("`")) {
      result.push({
        type: "text",
        text: { content: raw.slice(1, -1) },
        annotations: { code: true },
      });
    } else {
      result.push({
        type: "text",
        text: { content: raw.slice(2, -2) },
        annotations: { bold: true },
      });
    }
    last = m.index + raw.length;
  }
  if (last < text.length) {
    result.push({ type: "text", text: { content: text.slice(last) } });
  }
  return result.length ? result : [{ type: "text", text: { content: "" } }];
}

/** 마크다운 문자열을 Notion 블록 배열로 변환 (최대 95개) */
function markdownToBlocks(markdown: string): unknown[] {
  const lines = markdown.split("\n");
  const blocks: unknown[] = [];

  for (const raw of lines) {
    if (blocks.length >= 95) break;
    const line = raw.slice(0, 1900);

    if (line.startsWith("# ")) {
      blocks.push({
        object: "block", type: "heading_1",
        heading_1: { rich_text: parseInline(line.slice(2)) },
      });
    } else if (line.startsWith("## ")) {
      blocks.push({
        object: "block", type: "heading_2",
        heading_2: { rich_text: parseInline(line.slice(3)) },
      });
    } else if (line.startsWith("### ")) {
      blocks.push({
        object: "block", type: "heading_3",
        heading_3: { rich_text: parseInline(line.slice(4)) },
      });
    } else if (/^- \[.\] /.test(line)) {
      const checked = line[3] === "x";
      blocks.push({
        object: "block", type: "to_do",
        to_do: { rich_text: parseInline(line.slice(6)), checked },
      });
    } else if (/^- /.test(line)) {
      blocks.push({
        object: "block", type: "bulleted_list_item",
        bulleted_list_item: { rich_text: parseInline(line.slice(2)) },
      });
    } else if (/^\d+\. /.test(line)) {
      blocks.push({
        object: "block", type: "numbered_list_item",
        numbered_list_item: { rich_text: parseInline(line.replace(/^\d+\. /, "")) },
      });
    } else if (line.startsWith("---")) {
      blocks.push({ object: "block", type: "divider", divider: {} });
    } else if (line === "") {
      blocks.push({
        object: "block", type: "paragraph",
        paragraph: { rich_text: [] },
      });
    } else {
      blocks.push({
        object: "block", type: "paragraph",
        paragraph: { rich_text: parseInline(line) },
      });
    }
  }
  return blocks;
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
    const data = (await this.request("/pages", {
      method: "POST",
      body: {
        parent: { page_id: parentPageId },
        properties: {
          title: { title: [{ text: { content: title } }] },
        },
        children: markdownToBlocks(body),
      },
    })) as { id: string; url: string };
    return { id: data.id, url: data.url };
  }
}
