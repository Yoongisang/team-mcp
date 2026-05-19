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
    const text = await res.text();
    if (!text) return null;
    return JSON.parse(text);
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
    /** YYYY-MM-DD. Jira 표준 `duedate` 필드. */
    dueDate?: string;
    /** YYYY-MM-DD. customfield_10015 (Start date). */
    startDate?: string;
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
    if (opts.labels?.length) fields.labels = opts.labels;
    if (opts.dueDate) fields.duedate = opts.dueDate;
    if (opts.startDate) fields.customfield_10015 = opts.startDate;

    const data = (await this.request("/rest/api/3/issue", {
      method: "POST",
      body: { fields },
    })) as { key: string; id: string };

    // 스프린트 배정: 이슈 생성 후 별도 API로 추가 (customfield_10020 직접 설정 시 오류)
    if (opts.sprintId) {
      try {
        await this.request(`/rest/agile/1.0/sprint/${opts.sprintId}/issue`, {
          method: "POST",
          body: { issues: [data.key] },
        });
      } catch (e) {
        console.error(`[team-mcp] sprint 배정 실패 (${data.key}):`, String(e));
      }
    }

    return {
      key: data.key,
      id: data.id,
      url: `https://${this.host}/browse/${data.key}`,
    };
  }

  async getBoardId(projectKey: string): Promise<number | null> {
    // 팀 관리형 프로젝트는 type=scrum 필터에 걸리지 않으므로 type 없이 조회 먼저 시도
    for (const query of [
      `/rest/agile/1.0/board?projectKeyOrId=${projectKey}`,
      `/rest/agile/1.0/board?projectKeyOrId=${projectKey}&type=scrum`,
    ]) {
      try {
        const boards = (await this.request(query)) as { values?: Array<{ id: number; type?: string }> };
        const id = boards.values?.[0]?.id ?? null;
        if (id !== null) return id;
        console.error(`[team-mcp] getBoardId: no board for query "${query}", values:`, JSON.stringify(boards.values));
      } catch (e) {
        console.error(`[team-mcp] getBoardId failed query "${query}":`, String(e));
      }
    }
    return null;
  }

  /**
   * endDate(YYYY-MM-DD)가 일치하는 스프린트를 찾아 반환.
   * 없으면 새로 생성. 이슈 생성 시 sprintId로 직접 사용.
   */
  async getOrCreateSprintByEndDate(
    boardId: number,
    endDate: string,
    today: string,
  ): Promise<number | null> {
    const toSprintDateTime = (date: string, endOfDay: boolean) =>
      `${date}T${endOfDay ? "23:59:00.000" : "00:00:00.000"}Z`;

    try {
      // future/active 스프린트 중 endDate가 일치하는 것 검색
      for (const state of ["future", "active"]) {
        const data = (await this.request(
          `/rest/agile/1.0/board/${boardId}/sprint?state=${state}&maxResults=50`,
        )) as { values?: Array<{ id: number; endDate?: string }> };
        const found = (data.values ?? []).find((s) =>
          s.endDate?.startsWith(endDate),
        );
        if (found) return found.id;
      }
      // 없으면 새 스프린트 생성
      const sprint = (await this.request("/rest/agile/1.0/sprint", {
        method: "POST",
        body: {
          name: `Sprint ~${endDate}`,
          originBoardId: boardId,
          startDate: toSprintDateTime(today, false),
          endDate: toSprintDateTime(endDate, true),
        },
      })) as { id: number };
      return sprint.id;
    } catch (e) {
      console.error("[team-mcp] getOrCreateSprintByEndDate failed:", String(e));
      return null;
    }
  }

  async searchIssues(jql: string): Promise<Array<{ key: string; summary: string }>> {
    try {
      // Jira 2024 migration: /rest/api/3/search → /rest/api/3/search/jql
      // 페이지네이션은 nextPageToken 기반으로 변경됐지만, 본 메서드는 maxResults 50으로 단발성 검색이라 무시.
      const data = (await this.request("/rest/api/3/search/jql", {
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

  /**
   * 이슈를 "진행 중" 상태로 전이. 완료된 이슈를 회의에서 다시 살릴 때 사용.
   * "In Progress" / "진행 중" / "In Review" 등 다양한 이름을 탐색.
   */
  async transitionIssueToInProgress(issueKey: string): Promise<string> {
    const data = (await this.request(
      `/rest/api/3/issue/${issueKey}/transitions`,
    )) as { transitions?: Array<{ id: string; name: string }> };
    const transitions = data.transitions ?? [];
    const target =
      transitions.find(
        (t) =>
          t.name.toLowerCase() === "in progress" ||
          t.name === "진행 중" ||
          t.name === "진행중",
      ) ??
      transitions.find(
        (t) =>
          t.name.toLowerCase() === "to do" ||
          t.name === "할 일" ||
          t.name === "할일",
      );
    if (!target)
      throw new Error(
        `${issueKey}: '진행 중'/'할 일' 트랜지션 없음. 사용 가능: ${transitions
          .map((t) => t.name)
          .join(", ")}`,
      );
    await this.request(`/rest/api/3/issue/${issueKey}/transitions`, {
      method: "POST",
      body: { transition: { id: target.id } },
    });
    return target.name;
  }

  /**
   * 프로젝트의 모든 이슈를 페이지네이션으로 fetch.
   * 백로그 + 활성/미래 스프린트 작업 모두 포함.
   */
  async listAllIssues(projectKey: string): Promise<
    Array<{
      key: string;
      summary: string;
      status: string;
      issueType: string;
      assigneeName: string | null;
      assigneeAccountId: string | null;
      parentKey: string | null;
      labels: string[];
      dueDate: string | null;
      startDate: string | null;
      sprintId: number | null;
      sprintName: string | null;
    }>
  > {
    const fields = [
      "summary",
      "status",
      "issuetype",
      "assignee",
      "parent",
      "labels",
      "duedate",
      "customfield_10015", // start date
      "customfield_10020", // sprint (Jira Software 표준)
    ];
    const results: Array<Awaited<ReturnType<typeof this.listAllIssues>>[number]> = [];
    // Jira 2024 migration: /rest/api/3/search (startAt 기반) → /rest/api/3/search/jql (nextPageToken 기반)
    // 응답에서 total 필드가 사라지고 isLast / nextPageToken으로 종료 판정
    let nextPageToken: string | undefined = undefined;
    let totalFetched = 0;
    const maxResults = 100;
    while (true) {
      const body: Record<string, unknown> = {
        jql: `project = "${projectKey}" ORDER BY created ASC`,
        fields,
        maxResults,
      };
      if (nextPageToken) body.nextPageToken = nextPageToken;
      const data = (await this.request("/rest/api/3/search/jql", {
        method: "POST",
        body,
      })) as {
        issues?: Array<{
          key: string;
          fields: Record<string, unknown>;
        }>;
        nextPageToken?: string;
        isLast?: boolean;
      };
      const issues = data.issues ?? [];
      for (const i of issues) {
        const f = i.fields;
        const status = (f.status as { name?: string } | undefined)?.name ?? "";
        const issueType =
          (f.issuetype as { name?: string } | undefined)?.name ?? "";
        const assignee = f.assignee as
          | { displayName?: string; accountId?: string }
          | undefined
          | null;
        const parent = f.parent as { key?: string } | undefined;
        const sprints = f.customfield_10020 as
          | Array<{ id?: number; name?: string; state?: string }>
          | undefined;
        // 활성 또는 미래 스프린트 우선
        const activeSprint =
          sprints?.find((s) => s.state === "active") ?? sprints?.[0];
        results.push({
          key: i.key,
          summary: (f.summary as string) ?? "",
          status,
          issueType,
          assigneeName: assignee?.displayName ?? null,
          assigneeAccountId: assignee?.accountId ?? null,
          parentKey: parent?.key ?? null,
          labels: (f.labels as string[]) ?? [],
          dueDate: (f.duedate as string | null) ?? null,
          startDate: (f.customfield_10015 as string | null) ?? null,
          sprintId: activeSprint?.id ?? null,
          sprintName: activeSprint?.name ?? null,
        });
      }
      totalFetched += issues.length;
      // 종료 조건:
      //  1) isLast=true (Atlassian이 마지막 페이지임을 명시)
      //  2) nextPageToken이 없음 (더 이상 페이지 없음)
      //  3) 안전장치 — 1000개 초과
      if (data.isLast || !data.nextPageToken) break;
      if (totalFetched > 1000) break;
      nextPageToken = data.nextPageToken;
    }
    return results;
  }

  /**
   * 이슈 필드를 부분 업데이트. assignee/duedate/startDate/labels 지원.
   * 빈 값은 무시(기존 값 유지). null을 명시하면 필드 제거.
   */
  async updateIssue(
    issueKey: string,
    opts: {
      assigneeAccountId?: string | null;
      dueDate?: string | null;
      startDate?: string | null;
      addLabels?: string[];
    },
  ): Promise<void> {
    const fields: Record<string, unknown> = {};
    if (opts.assigneeAccountId !== undefined) {
      fields.assignee =
        opts.assigneeAccountId === null
          ? null
          : { accountId: opts.assigneeAccountId };
    }
    if (opts.dueDate !== undefined) fields.duedate = opts.dueDate;
    if (opts.startDate !== undefined) fields.customfield_10015 = opts.startDate;
    if (opts.addLabels?.length) {
      // 라벨 추가는 update[].add 문법
      await this.request(`/rest/api/3/issue/${issueKey}`, {
        method: "PUT",
        body: {
          update: {
            labels: opts.addLabels.map((l) => ({ add: l })),
          },
        },
      });
    }
    if (Object.keys(fields).length > 0) {
      await this.request(`/rest/api/3/issue/${issueKey}`, {
        method: "PUT",
        body: { fields },
      });
    }
  }

  /**
   * 이슈에 코멘트 추가. 회의 출처/맥락을 남기는 용도.
   */
  async addComment(issueKey: string, text: string): Promise<void> {
    await this.request(`/rest/api/3/issue/${issueKey}/comment`, {
      method: "POST",
      body: {
        body: {
          type: "doc",
          version: 1,
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text }],
            },
          ],
        },
      },
    });
  }

  /**
   * 표시 이름(displayName)으로 사용자 검색 → accountId 반환.
   * 동명이인은 첫 번째 매치 사용. 없으면 null.
   */
  async findUserByDisplayName(
    name: string,
    projectKey: string,
  ): Promise<{ accountId: string; displayName: string } | null> {
    try {
      const data = (await this.request(
        `/rest/api/3/user/assignable/search?query=${encodeURIComponent(
          name,
        )}&project=${projectKey}&maxResults=10`,
      )) as Array<{ accountId: string; displayName: string }>;
      if (data.length === 0) return null;
      // displayName 정확 매치 우선
      const exact = data.find((u) => u.displayName === name);
      return exact ?? data[0]!;
    } catch {
      return null;
    }
  }

  /**
   * 이슈를 스프린트로 이동. 기존에 스프린트가 있으면 옮겨감.
   */
  async moveIssuesToSprint(
    sprintId: number,
    issueKeys: string[],
  ): Promise<void> {
    if (issueKeys.length === 0) return;
    await this.request(`/rest/agile/1.0/sprint/${sprintId}/issue`, {
      method: "POST",
      body: { issues: issueKeys },
    });
  }
}
