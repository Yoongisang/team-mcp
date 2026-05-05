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

  async getBoardId(projectKey: string): Promise<number | null> {
    try {
      const boards = (await this.request(
        `/rest/agile/1.0/board?projectKeyOrId=${projectKey}&type=scrum`,
      )) as { values?: Array<{ id: number }> };
      return boards.values?.[0]?.id ?? null;
    } catch {
      return null;
    }
  }

  async createSprint(
    boardId: number,
    name: string,
    startDate: string,
    endDate: string,
  ): Promise<number | null> {
    try {
      const sprint = (await this.request("/rest/agile/1.0/sprint", {
        method: "POST",
        body: { name, originBoardId: boardId, startDate, endDate },
      })) as { id: number };
      // 생성된 스프린트 활성화
      await this.request(`/rest/agile/1.0/sprint/${sprint.id}`, {
        method: "PUT",
        body: { state: "active", startDate, endDate },
      });
      return sprint.id;
    } catch (e) {
      console.error("[team-mcp] createSprint failed:", e);
      return null;
    }
  }

  async moveIssuesToSprint(sprintId: number, issueKeys: string[]): Promise<void> {
    if (issueKeys.length === 0) return;
    await this.request(`/rest/agile/1.0/sprint/${sprintId}/issue`, {
      method: "POST",
      body: { issues: issueKeys },
    });
  }

  async searchIssues(jql: string): Promise<Array<{ key: string; summary: string }>> {
    try {
      const data = (await this.request("/rest/api/3/issue/search", {
        method: "POST",
        body: { jql, fields: ["summary", "status"], maxResults: 50 },
      })) as { issues?: Array<{ key: string; fields: { summary: string } }> };
      return (data.issues ?? []).map((i) => ({
        key: i.key,
        summary: i.fields.summary,
      }));
    } catch {
      return [];
    }
  }

  async transitionIssueToDone(issueKey: string): Promise<void> {
    const data = (await this.request(
      `/rest/api/3/issue/${issueKey}/transitions`,
    )) as { transitions?: Array<{ id: string; name: string }> };
    const transitions = data.transitions ?? [];
    const done = transitions.find(
      (t) =>
        t.name.toLowerCase() === "done" ||
        t.name === "완료" ||
        t.name.toLowerCase().includes("done"),
    );
    if (!done) throw new Error(`${issueKey}: Done 트랜지션 없음`);
    await this.request(`/rest/api/3/issue/${issueKey}/transitions`, {
      method: "POST",
      body: { transition: { id: done.id } },
    });
  }
}
