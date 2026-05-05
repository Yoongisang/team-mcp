import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { config, requireConfig } from "../config.js";
import {
  DiscordClient,
  resolveForumTagIds,
  type DiscordMessage,
} from "../lib/discord.js";
import { JiraClient, type CreatedIssue } from "../lib/jira.js";
import { NotionLock } from "../lib/lock.js";
import { NotionClient } from "../lib/notion.js";
import { checkPermission } from "../lib/safety.js";
import { loadState, saveState } from "../lib/state.js";

export const finishMeetingTool: Tool = {
  name: "finish_meeting",
  description:
    "PM/팀장 전용. 진행 중인 회의 포럼 스레드의 댓글을 모두 수집해 " +
    "Notion 회의록 + Jira 이슈 생성, 원본 스레드 태그를 [진행]→[완료]로 교체, " +
    "같은 포럼에 [정리] 태그로 새 요약 스레드 생성. " +
    "인자 없이 호출하면 메시지 컨텍스트만 반환하며, summary와 action_items를 " +
    "분석해 다시 호출하면 작성·태그 변경·요약 스레드 생성을 수행한다.",
  inputSchema: {
    type: "object",
    properties: {
      invoker_id: {
        type: "string",
        description:
          "호출자 Discord user ID (snowflake, 긴 숫자). " +
          "ALLOWED_USERS 검증 대상이며 username이 아닌 ID여야 함. " +
          "Discord 메시지로 트리거된 경우 메시지 메타데이터의 author.id를 그대로 전달.",
      },
      summary: {
        type: "string",
        description: "회의 요약 (Notion 본문·Jira description·정리 스레드에 들어감)",
      },
      action_items: {
        type: "array",
        items: { type: "string" },
        description: "액션 아이템 목록",
      },
      title: {
        type: "string",
        description: "회의록 제목 (기본: '스크럼 회의록 YYYY-MM-DD')",
      },
    },
    required: ["invoker_id"],
    additionalProperties: false,
  },
};

const Args = z.object({
  invoker_id: z.string().min(1),
  summary: z.string().optional(),
  action_items: z.array(z.string()).optional(),
  title: z.string().optional(),
});

function formatMessage(m: DiscordMessage): string {
  const ts = m.timestamp.slice(0, 19).replace("T", " ");
  return `[${ts}] @${m.author.username}: ${m.content}`;
}

export async function finishMeeting(raw: unknown) {
  const args = Args.parse(raw);

  checkPermission(args.invoker_id, config.allowedUsers);

  const token = requireConfig(config.discord.botToken, "DISCORD_BOT_TOKEN");
  const forumId = requireConfig(
    config.discord.scrumChannelId,
    "DISCORD_SCRUM_CHANNEL_ID",
  );

  const discord = new DiscordClient(token);
  const state = await loadState();

  if (!state.currentMeetingThreadId) {
    throw new Error(
      "진행 중인 회의 스레드가 없습니다. 먼저 prepare_meeting을 호출해 " +
        "포럼에 [진행] 태그 스레드를 생성하세요.",
    );
  }
  const threadId = state.currentMeetingThreadId;

  // 스레드의 모든 댓글 수집 (스레드 자체도 채널이라 listMessages 사용 가능)
  const raw_messages = await discord.listMessages(threadId, { limit: 100 });
  const messages = raw_messages
    .filter((m) => m.author && !m.author.username.endsWith("[BOT]"))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  if (!args.summary || !args.action_items) {
    const ctx = messages.length === 0
      ? "(수집된 댓글 없음)"
      : messages.map(formatMessage).join("\n");
    const text = [
      "# 회의록 작성 컨텍스트",
      `_스레드: ${threadId}, 댓글 ${messages.length}건._`,
      "",
      "## 스레드 댓글",
      ctx,
      "",
      "---",
      "위 내용을 분석해 다음을 정리한 뒤 finish_meeting을 다시 호출하라:",
      "  - summary: 회의 요약",
      "  - action_items: 액션 아이템 배열",
      "  - title (선택): 회의록 제목",
      "재호출 시 락 획득 → Notion + Jira 작성 → 원본 스레드 태그 [진행]→[완료] → 새 [정리] 스레드 생성을 수행한다.",
    ].join("\n");
    return { content: [{ type: "text" as const, text }] };
  }

  const notionToken = requireConfig(config.notion.apiKey, "NOTION_API_KEY");
  const notionParent = requireConfig(
    config.notion.parentPageId,
    "NOTION_PARENT_PAGE_ID",
  );
  const notionLockDb = requireConfig(
    config.notion.lockDbId,
    "NOTION_LOCK_DB_ID",
  );
  const jiraToken = requireConfig(config.jira.apiToken, "JIRA_API_TOKEN");
  const jiraEmail = requireConfig(config.jira.email, "JIRA_EMAIL");
  const jiraHost = requireConfig(config.jira.host, "JIRA_HOST");
  const jiraProject = requireConfig(
    config.jira.projectKey,
    "JIRA_PROJECT_KEY",
  );

  const notion = new NotionClient(notionToken);
  const lock = new NotionLock(notion, notionLockDb);
  const jira = new JiraClient(jiraHost, jiraEmail, jiraToken);

  // 포럼 태그 ID 미리 해석 (실패 시 락 잡기 전에 빠르게 fail)
  const forum = await discord.getChannel(forumId);
  const [completedTagId, summaryTagId] = resolveForumTagIds(forum, [
    config.discord.tagCompleted,
    config.discord.tagSummary,
  ]);

  const acquired = await lock.acquire();
  try {
    const today = new Date().toISOString().slice(0, 10);
    const title = args.title ?? `스크럼 회의록 ${today}`;

    const itemsBlock = args.action_items
      .map((it, i) => `${i + 1}. ${it}`)
      .join("\n");
    const notionBody = [
      `# ${title}`,
      "",
      "## 요약",
      args.summary,
      "",
      "## 액션 아이템",
      itemsBlock || "(없음)",
      "",
      "## 원본 댓글",
      messages.length === 0
        ? "(없음)"
        : messages.map(formatMessage).join("\n"),
    ].join("\n");

    const notionPage = await notion.createMeetingPage(
      notionParent,
      title,
      notionBody,
    );

    // 활성 스프린트 조회 (실패해도 이슈 생성은 계속)
    const sprintId = await jira.getActiveSprintId(jiraProject);

    // 액션 아이템별 개별 Jira Task 생성
    const actionIssues: CreatedIssue[] = [];
    for (const item of args.action_items) {
      const issue = await jira.createIssue({
        projectKey: jiraProject,
        summary: item,
        description: `회의록 참조: ${notionPage.url}`,
        issueType: "Task",
        sprintId,
        labels: ["scrum-action-item"],
      });
      actionIssues.push(issue);
    }

    // 회의 요약 Jira Task 생성
    const jiraDescription = [
      args.summary,
      "",
      "Action Items:",
      args.action_items.map((it, i) => `${i + 1}. ${it}`).join("\n"),
      "",
      `Notion: ${notionPage.url}`,
    ].join("\n");

    const summaryIssue = await jira.createIssue({
      projectKey: jiraProject,
      summary: title,
      description: jiraDescription,
      issueType: "Task",
      sprintId,
      labels: ["scrum-meeting"],
    });

    // 원본 스레드 태그 [진행] → [완료] 교체
    await discord.setThreadTags(threadId, [completedTagId!]);

    // [정리] 태그 새 스레드 생성
    const summaryThreadName = `스크럼 회의 정리 ${today}`;
    const jiraActionLinks = actionIssues
      .map((iss, i) => `- [${iss.key}] ${args.action_items![i]}: ${iss.url}`)
      .join("\n");
    const summaryContent = [
      `# ${title}`,
      "",
      "## 요약",
      args.summary,
      "",
      "## 액션 아이템 (Jira 티켓)",
      jiraActionLinks || "(없음)",
      "",
      "## 링크",
      `- 원본 회의 스레드: <#${threadId}>`,
      `- Notion: ${notionPage.url}`,
      `- Jira 회의 요약: ${summaryIssue.url}`,
    ].join("\n");

    const { thread: summaryThread } = await discord.createForumThread(
      forumId,
      summaryThreadName,
      summaryContent,
      [summaryTagId!],
    );

    // state 클리어
    state.currentMeetingThreadId = null;
    await saveState(state);

    return {
      content: [
        {
          type: "text" as const,
          text:
            `회의록 작성 완료\n` +
            `  댓글 수집: ${messages.length}건\n` +
            `  원본 스레드 태그: [${config.discord.tagInProgress}] → [${config.discord.tagCompleted}]\n` +
            `  정리 스레드: ${summaryThread.id} (${summaryThread.name})\n` +
            `  Notion: ${notionPage.url}\n` +
            `  Jira 액션 아이템: ${actionIssues.length}개 (${actionIssues.map(i => i.key).join(", ")})\n` +
            `  Jira 회의 요약: ${summaryIssue.url}\n` +
            `  락 ID: ${acquired.id} (TTL ${acquired.expiresAt})`,
        },
      ],
    };
  } finally {
    await lock.release(acquired.id).catch((e) => {
      console.error("[team-mcp] lock release failed:", e);
    });
  }
}
