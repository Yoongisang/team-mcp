export interface CreatedIssue {
  key: string;
  id: string;
  url: string;
}

export class JiraClient {
  constructor(
    private readonly host: string,
    private readonly email: string,
    private readonly token: string,
  ) {}

  private async request(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<unknown> {
    const auth = Buffer.from(`${this.email}:${this.token}`).toString("base64");
    const res = await fetch(`https://${this.host}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Jira API ${res.status} ${res.statusText}: ${body.slice(0, 300)}`,
      );
    }
    return await res.json();
  }

  async createIssue(opts: {
    projectKey: string;
    summary: string;
    description?: string;
    issueType?: string;
  }): Promise<CreatedIssue> {
    const description = opts.description
      ? {
          type: "doc",
          version: 1,
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: opts.description }],
            },
          ],
        }
      : undefined;

    const fields: Record<string, unknown> = {
      project: { key: opts.projectKey },
      summary: opts.summary.slice(0, 250),
      issuetype: { name: opts.issueType ?? "Task" },
    };
    if (description) fields.description = description;

    const data = (await this.request("/rest/api/3/issue", {
      method: "POST",
      body: { fields },
    })) as { key: string; id: string };

    return {
      key: data.key,
      id: data.id,
      url: `https://${this.host}/browse/${data.key}`,
    };
  }
}
