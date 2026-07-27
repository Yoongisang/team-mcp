import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { config, requireConfig } from "../config.js";
import {
  DiscordClient,
  discordDisplayName,
  resolveForumTagIds,
  type DiscordMessage,
} from "../lib/discord.js";
import { NotionLock } from "../lib/lock.js";
import { NotionClient } from "../lib/notion.js";
import {
  currentMeetingDate,
  latestInProgressMeeting,
  meetingSequence,
} from "../lib/meeting-threads.js";
import { checkPermission } from "../lib/safety.js";
import { loadState, saveState } from "../lib/state.js";
import {
  GAME_FILES,
  gameFileExists,
  readGameFile,
  writeGameFile,
} from "../lib/files.js";
import { parseChecklist, setItemDone, joinLines } from "../lib/markdown.js";

export const finishMeetingTool: Tool = {
  name: "finish_meeting",
  description:
    "PM/팀장 전용. 오늘 날짜의 가장 최근 [진행] 회의 포럼 스레드 댓글을 모두 수집해 " +
    "Notion 회의록을 만들고, 원본 스레드 태그를 [진행]→[완료]로 교체한 뒤 " +
    "같은 포럼에 [정리] 태그로 새 요약 스레드 생성. " +
    "인자 없이 호출하면 메시지 컨텍스트만 반환하며, summary와 action_items를 " +
    "분석해 다시 호출하면 Notion 작성·태그 변경·요약 스레드 생성까지만 수행한다. " +
    "Jira에는 이 단계에서 절대 쓰지 않으며, 후속 apply_meeting_to_backlog의 미리보기와 승인 단계를 사용한다.",
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
        description: "회의 요약 (Notion 본문과 Discord 정리 스레드에 들어감)",
      },
      action_items: {
        type: "array",
        items: { type: "string" },
        description: "액션 아이템 목록",
      },
      title: {
        type: "string",
        description: "회의록 제목 (기본: '스크럼 회의록 YYYY-MM-DD (N차)')",
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
  return `[${ts}] ${discordDisplayName(m)}: ${m.content}`;
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
  const today = currentMeetingDate();
  const forum = await discord.getChannel(forumId);
  const [inProgressTagId, completedTagId, summaryTagId] = resolveForumTagIds(
    forum,
    [
      config.discord.tagInProgress,
      config.discord.tagCompleted,
      config.discord.tagSummary,
    ],
  );
  const forumThreads = await discord.listForumThreads(forumId);
  let meetingThread = latestInProgressMeeting(
    forumThreads,
    inProgressTagId!,
    today,
  );

  if (!meetingThread) {
    throw new Error(
      `오늘(${today}) 진행 중인 회의 스레드가 없습니다. ` +
        "먼저 prepare_meeting을 호출해 포럼에 [진행] 태그 스레드를 생성하세요.",
    );
  }
  const meetingNumber = meetingSequence(meetingThread.name, today) ?? 1;
  if (meetingThread.thread_metadata?.archived || meetingThread.archived) {
    meetingThread = await discord.setThreadArchived(meetingThread.id, false);
  }
  const threadId = meetingThread.id;

  // 스레드의 모든 댓글 수집 (스레드 자체도 채널이라 listMessages 사용 가능)
  const raw_messages = await discord.listAllMessages(threadId, 1000);
  const messages = raw_messages
    .filter((m) => m.author && !m.author.bot)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  // ── 확인 대기 항목 처리 ────────────────────────────────────────────────
  const pending = state.pendingConfirmations ?? [];
  const confirmedItems: string[] = [];

  if (pending.length > 0 && messages.length > 0) {
    // 사용자 메시지에서 명시적인 확인 번호만 파싱.
    // 일반 회의 발화의 숫자(이슈 번호, 날짜 등)는 체크리스트 완료 근거로 쓰지 않는다.
    const confirmedIndexes = new Set<number>();
    for (const msg of messages) {
      if (!/(confirmed_indexes|완료\s*번호|완료된\s*항목)/i.test(msg.content)) {
        continue;
      }
      const nums = [...msg.content.matchAll(/\b(\d+)\b/g)].map(m => parseInt(m[1]!, 10));
      nums.forEach(n => confirmedIndexes.add(n));
    }

    if (confirmedIndexes.size > 0 && await gameFileExists(GAME_FILES.checklist)) {
      const raw = await readGameFile(GAME_FILES.checklist);
      const { items, lines } = parseChecklist(raw);
      let updatedLines = lines;

      for (const p of pending) {
        if (!confirmedIndexes.has(p.index)) continue;
        const target = items.find(i => !i.done && i.text === p.itemText);
        if (target) {
          updatedLines = setItemDone(updatedLines, target, true);
          confirmedItems.push(p.itemText);
        }
      }

      if (confirmedItems.length > 0) {
        await writeGameFile(GAME_FILES.checklist, joinLines(updatedLines), { overwrite: true });
        state.pendingConfirmations = pending.filter(
          p => !confirmedItems.includes(p.itemText),
        );
        await saveState(state);
      }
    }
  }

  if (!args.summary || !args.action_items) {
    const ctx = messages.length === 0
      ? "(수집된 댓글 없음)"
      : messages.map(formatMessage).join("\n");
    const confirmedNote = confirmedItems.length > 0
      ? `\n\n> ✅ 확인 완료로 체크리스트 갱신: ${confirmedItems.join(", ")}`
      : "";
    const text = [
      "# 회의록 작성 컨텍스트",
      `_스레드: ${meetingThread.name} (${threadId}), 댓글 ${messages.length}건._${confirmedNote}`,
      "",
      "## 스레드 댓글",
      ctx,
      "",
      "---",
      "위 내용을 분석해 다음을 정리한 뒤 finish_meeting을 다시 호출하라:",
      "  - summary: 회의 요약",
      "  - action_items: 액션 아이템 배열",
      "  - title (선택): 회의록 제목",
      "재호출 시 락 획득 → Notion 작성 → 원본 스레드 태그 [진행]→[완료] → 새 [정리] 스레드 생성을 수행한다.",
      "이 단계에서는 Jira를 생성·수정하지 않는다. 이후 사용자가 '진행'을 요청하면 apply_meeting_to_backlog로 Jira 반영안 미리보기를 정리 스레드에 게시한다.",
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
  const notion = new NotionClient(notionToken);
  const lock = new NotionLock(notion, notionLockDb);

  const acquired = await lock.acquire();
  try {
    const title = args.title ?? `스크럼 회의록 ${today} (${meetingNumber}차)`;

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

    // 원본 스레드 태그 [진행] → [완료] 교체
    await discord.setThreadTags(threadId, [completedTagId!]);

    // [정리] 태그 새 스레드 생성
    const summaryThreadName = `스크럼 회의 정리 ${today} (${meetingNumber}차)`;
    const summaryContent = [
      `# ${title}`,
      "",
      "## 요약",
      args.summary,
      "",
      "## 액션 아이템",
      args.action_items.map((it, i) => `${i + 1}. ${it}`).join("\n") ||
        "(없음)",
      "",
      "## 링크",
      `- 원본 회의 스레드: <#${threadId}>`,
      `- Notion: ${notionPage.url}`,
      "",
      "> Jira에는 아직 반영하지 않았습니다. `진행` 단계에서 미리보기를 확인한 뒤 승인하면 적용됩니다.",
    ].join("\n");

    const { thread: summaryThread } = await discord.createForumThread(
      forumId,
      summaryThreadName,
      summaryContent,
      [summaryTagId!],
    );

    // state 클리어 + 다음 prepare_meeting의 since 기준 갱신.
    // Jira 미리보기는 방금 만든 [정리] 스레드에만 게시하도록 두 ID를 함께 보관한다.
    state.lastFinishedMeetingThreadId = threadId;
    state.lastFinishedMeetingSummaryThreadId = summaryThread.id;
    state.lastPrepareMeetingAt = new Date().toISOString();
    state.currentMeetingThreadId = null;
    state.pendingConfirmations = [];
    state.pendingBacklogApproval = null;
    state.lastBacklogPreviewThreadId = null;
    state.lastBacklogPreviewSourceThreadId = null;
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
            `  Jira 변경: 없음\n` +
            `  락 ID: ${acquired.id} (TTL ${acquired.expiresAt})\n\n` +
            `다음 단계:\n` +
            `  사용자가 "진행"을 요청하면 apply_meeting_to_backlog로 Jira 반영안을 분석하고\n` +
            `  위 정리 스레드에 미리보기를 게시한다. Jira 적용은 별도 승인 후에만 수행한다.`,
        },
      ],
    };
  } finally {
    await lock.release(acquired.id).catch((e) => {
      console.error("[team-mcp] lock release failed:", e);
    });
  }
}
