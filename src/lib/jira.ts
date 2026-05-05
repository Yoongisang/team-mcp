export interface CreatedIssue {
  key: string;
  id: string;
  url: string;
}

export interface Sprint {
  id: number;
  name: string;
  state: string;
}

export class JiraClient {
  constructor(
    private readonly host: string,
    private readonly email: string,
    private readonly token: string,
  ) {}

  private get auth() {
    return Buffer.from(`${this.email}:${this.token}`).toString("base64");
  }

  private async request(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<unknown> {
    const res = await fetch(`https://${this.host}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Basic ${this.auth}`,
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

  /**
   * 프로젝트의 활성 스크럼 스프린트 ID 반환. 없거나 실패 시 null.
   * Jira Agile API(/rest/agile/1.0/)를 사용하므로 Jira Software가 필요.
   */
  async getActiveSprintId(projectKey: string): Promise<number | null> {
    try {
      const boards = (await this.request(
        `/rest/agile/1.0/board?projectKeyOrId=${projectKey}&type=scrum`,
      )) as { values?: Array<{ id: number }> };
      const boardId = boards.values?.[0]?.id;
      if (!boardId) return null;

      const sprints = (await this.request(
        `/rest/agile/1.0/board/${boardId}/sprint?state=active`,
      )) as { values?: Sprint[] };
      return sprints.values?.[0]?.id ?? null;
    } catch {
      // 스프린트 조회 실패는 치명적이지 않음 — 스프린트 없이 이슈만 생성
      return null;
    }
  }

  async createIssue(opts: {
    projectKey: string;
    summary: string;
    description?: string;
    issueType?: string;
    sprintId?: number | null;
    labels?: string[];
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
    if (opts.sprintId) fields.customfield_10020 = opts.sprintId;
    if (opts.labels?.length) fields.labels = opts.labels;

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
