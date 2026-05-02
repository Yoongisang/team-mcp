import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { config, requireConfig } from "../config.js";
import { DiscordClient, type DiscordMessage } from "../lib/discord.js";
import { JiraClient } from "../lib/jira.js";
import { NotionLock } from "../lib/lock.js";
import { NotionClient } from "../lib/notion.js";
import { checkPermission, safeArchive } from "../lib/safety.js";
import { loadState } from "../lib/state.js";

export const finishMeetingTool: Tool = {
  name: "finish_meeting",
  description:
    "PM/팀장 전용. Discord 스크럼 메시지를 수집해 아카이브 채널로 안전 복사 후 원본 삭제, " +
    "Notion에 회의록 페이지 + Jira 이슈 생성. 인자 없이 호출하면 메시지 컨텍스트만 반환하며, " +
    "summary와 action_items를 분석해 다시 호출하면 작성·아카이브를 수행한다.",
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
        description: "회의 요약 (Notion 본문·Jira description에 들어감)",
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

function snowflakeFromDate(d: Date): string {
  const DISCORD_EPOCH = 1420070400000n;
  const ms = BigInt(d.getTime()) - DISCORD_EPOCH;
  return ((ms << 22n) | 0n).toString();
}

function formatMessage(m: DiscordMessage): string {
  const ts = m.timestamp.slice(0, 19).replace("T", " ");
  return `[${ts}] @${m.author.username}: ${m.content}`;
}

export async function finishMeeting(raw: unknown) {
  const args = Args.parse(raw);

  checkPermission(args.invoker_id, config.allowedUsers);

  const token = requireConfig(config.discord.botToken, "DISCORD_BOT_TOKEN");
  const scrumChannelId = requireConfig(
    config.discord.scrumChannelId,
    "DISCORD_SCRUM_CHANNEL_ID",
  );
  const archiveChannelId = requireConfig(
    config.discord.archiveChannelId,
    "DISCORD_ARCHIVE_CHANNEL_ID",
  );

  const discord = new DiscordClient(token);

  const state = await loadState();
  const since = state.lastPrepareMeetingAt
    ? new Date(state.lastPrepareMeetingAt)
    : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const afterId = snowflakeFromDate(since);

  const raw_messages = await discord.listMessages(scrumChannelId, {
    after: afterId,
    limit: 100,
  });
  const messages = raw_messages
    .filter((m) => m.author && !m.author.username.endsWith("[BOT]"))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  if (!args.summary || !args.action_items) {
    const ctx = messages.length === 0
      ? "(수집된 메시지 없음)"
      : messages.map(formatMessage).join("\n");
    const text = [
      "# 회의록 작성 컨텍스트",
      `_수집 기간: ${since.toISOString()} ~ 지금. 메시지 ${messages.length}건._`,
      "",
      "## 스크럼 채널 메시지",
      ctx,
      "",
      "---",
      "위 내용을 분석해 다음을 정리한 뒤 finish_meeting을 다시 호출하라:",
      "  - summary: 회의 요약",
      "  - action_items: 액션 아이템 배열",
      "  - title (선택): 회의록 제목",
      "재호출 시 락 획득 → 아카이브 → Notion + Jira 작성을 수행한다.",
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

  const acquired = await lock.acquire();
  try {
    const archiveResult = await safeArchive(
      messages,
      async (items) => {
        const ids: string[] = [];
        for (const m of items) {
          const sent = await discord.postMessage(
            archiveChannelId,
            formatMessage(m),
          );
          ids.push(sent.id);
        }
        return ids;
      },
      async () => {
        await discord.bulkDelete(
          scrumChannelId,
          messages.map((m) => m.id),
        );
      },
    );

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
      "## 원본 메시지",
      messages.length === 0
        ? "(없음)"
        : messages.map(formatMessage).join("\n"),
    ].join("\n");

    const notionPage = await notion.createMeetingPage(
      notionParent,
      title,
      notionBody,
    );

    const jiraDescription = [
      args.summary,
      "",
      "Action items:",
      itemsBlock || "(none)",
      "",
      `Notion: ${notionPage.url}`,
    ].join("\n");

    const jiraIssue = await jira.createIssue({
      projectKey: jiraProject,
      summary: title,
      description: jiraDescription,
    });

    return {
      content: [
        {
          type: "text" as const,
          text:
            `회의록 작성 완료\n` +
            `  메시지 수집: ${messages.length}건\n` +
            `  아카이브: ${archiveResult.archived}/${archiveResult.source}건\n` +
            `  Notion: ${notionPage.url}\n` +
            `  Jira: ${jiraIssue.url}\n` +
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
