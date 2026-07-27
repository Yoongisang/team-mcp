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
        description: "회의록 제목 (기본: '스크럼 회의록 YYYY-MM-DD (N차)')",
      },
      sprint_end_date: {
        type: "string",
        description:
          "스프린트 종료일 (YYYY-MM-DD). 회의에서 언급된 가장 늦은 마감일. " +
          "제공 시 오늘~해당일로 스프린트를 자동 생성하고 이슈를 넣는다.",
      },
      completed_task_names: {
        type: "array",
        items: { type: "string" },
        description:
          "이번 회의에서 완료됐다고 언급된 작업명 목록. " +
          "Jira에서 유사한 이슈를 찾아 Done 처리.",
      },
      create_action_issues: {
        type: "boolean",
        description:
          "true이면 승인 미리보기 없이 액션 아이템마다 새 Jira Task를 즉시 생성한다. " +
          "기본 false — apply_meeting_to_backlog의 미리보기·확인 절차를 거친 뒤 " +
          "새 실행 항목을 Jira 이슈로 발행하는 흐름을 권장한다.",
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
  sprint_end_date: z.string().optional(),
  completed_task_names: z.array(z.string()).optional(),
  create_action_issues: z.boolean().optional(),
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
      "  - sprint_end_date (선택): 회의에서 언급된 가장 늦은 마감일 YYYY-MM-DD",
      "  - completed_task_names (선택): 완료됐다고 언급된 작업명 목록",
      "재호출 시 락 획득 → Notion + Jira 작성 → 스프린트 생성/이슈 이동 → 완료 처리 → 원본 스레드 태그 [진행]→[완료] → 새 [정리] 스레드 생성을 수행한다.",
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

    // ── 마감일 파싱 헬퍼 ──────────────────────────────────────────────
    function parseDateFromItem(text: string): string | undefined {
      const year = new Date().getFullYear();
      let m: RegExpMatchArray | null;
      // M/D 또는 MM/DD
      m = text.match(/(\d{1,2})\/(\d{1,2})/);
      if (m) return new Date(year, +m[1]! - 1, +m[2]!).toISOString().slice(0, 10);
      // M월D일
      m = text.match(/(\d{1,2})월\s*(\d{1,2})일/);
      if (m) return new Date(year, +m[1]! - 1, +m[2]!).toISOString().slice(0, 10);
      // YYYY-MM-DD
      m = text.match(/(\d{4})-(\d{2})-(\d{2})/);
      if (m) return `${m[1]}-${m[2]}-${m[3]}`;
      return undefined;
    }

    // ── 액션 아이템별 Jira Task 생성 (옵트인) ─────────────────────────
    // 기본 false: 승인 미리보기 없이 Jira 이슈를 바로 생성하지 않기 위함.
    // 새 액션 발행과 명시적인 기존 이슈 변경은 apply_meeting_to_backlog에서 처리.
    const actionIssues: CreatedIssue[] = [];
    if (args.create_action_issues === true) {
      for (const item of args.action_items) {
        const deadline = parseDateFromItem(item);
        const issue = await jira.createIssue({
          projectKey: jiraProject,
          summary: item,
          description: `회의록 참조: ${notionPage.url}`,
          issueType: config.jira.taskType,
          labels: ["scrum-action-item"],
          startDate: today,
          dueDate: deadline,
        });
        actionIssues.push(issue);
      }
    }

    const jiraDescription = [
      args.summary,
      "",
      "Action Items:",
      args.action_items.map((it, i) => `${i + 1}. ${it}`).join("\n"),
      "",
      `Notion: ${notionPage.url}`,
    ].join("\n");

    const latestDeadline = args.action_items
      .map(parseDateFromItem)
      .filter((d): d is string => !!d)
      .sort()
      .at(-1);

    // 회의 메타 이슈도 create_action_issues 플래그에 묶음
    // (기본 false → 백로그 오염 방지; 회의록은 Notion에만 남고 Jira엔 안 남음)
    const summaryIssue =
      args.create_action_issues === true
        ? await jira.createIssue({
            projectKey: jiraProject,
            summary: title,
            description: jiraDescription,
            issueType: config.jira.taskType,
            labels: ["scrum-meeting"],
            startDate: today,
            dueDate: latestDeadline,
          })
        : null;

    const sprintInfo = "백로그에 생성됨 (무료 요금제 — 스프린트 배정은 Jira UI에서)";

    // ── 완료 처리: 이번 회의에서 완료된 작업 → 이전 이슈 Done 처리 ──
    const completedResults: string[] = [];
    for (const taskName of args.completed_task_names ?? []) {
      try {
        const escaped = taskName.replace(/"/g, '\\"');
        const found = await jira.searchIssues(
          `project = "${jiraProject}" AND summary ~ "${escaped}" AND status != Done ORDER BY created DESC`,
        );
        if (found.length > 0) {
          await jira.transitionIssueToDone(found[0]!.key);
          completedResults.push(`${found[0]!.key} (${found[0]!.summary})`);
        }
      } catch (e) {
        completedResults.push(`실패: ${taskName} — ${e}`);
      }
    }

    // 원본 스레드 태그 [진행] → [완료] 교체
    await discord.setThreadTags(threadId, [completedTagId!]);

    // [정리] 태그 새 스레드 생성
    const summaryThreadName = `스크럼 회의 정리 ${today} (${meetingNumber}차)`;
    const jiraActionLinks = actionIssues
      .map((iss, i) => `- [${iss.key}] ${args.action_items![i]}: ${iss.url}`)
      .join("\n");
    const summaryContent = [
      `# ${title}`,
      "",
      "## 요약",
      args.summary,
      "",
      "## 액션 아이템",
      args.create_action_issues === true
        ? jiraActionLinks || "(없음)"
        : args.action_items.map((it, i) => `${i + 1}. ${it}`).join("\n") ||
          "(없음)",
      "",
      "## 링크",
      `- 원본 회의 스레드: <#${threadId}>`,
      `- Notion: ${notionPage.url}`,
      ...(summaryIssue ? [`- Jira 회의 요약: ${summaryIssue.url}`] : []),
    ].join("\n");

    const { thread: summaryThread } = await discord.createForumThread(
      forumId,
      summaryThreadName,
      summaryContent,
      [summaryTagId!],
    );

    // state 클리어 + 다음 prepare_meeting의 since 기준 갱신
    // currentMeetingThreadId는 클리어 직전에 lastFinishedMeetingThreadId로 백업
    // → apply_meeting_to_backlog가 finish_meeting 직후에도 같은 스레드 댓글 참조 가능
    state.lastFinishedMeetingThreadId = threadId;
    state.lastPrepareMeetingAt = new Date().toISOString();
    state.currentMeetingThreadId = null;
    state.pendingConfirmations = [];
    await saveState(state);

    const jiraLine = summaryIssue
      ? `  Jira 회의 요약: ${summaryIssue.url}\n`
      : `  Jira 회의 요약: (생략 — create_action_issues=false)\n`;
    const actionLine =
      args.create_action_issues === true
        ? `  Jira 액션 아이템: ${actionIssues.length}개 (${actionIssues
            .map((i) => i.key)
            .join(", ")})\n`
        : `  Jira 액션 아이템: (생략 — apply_meeting_to_backlog 미리보기·확정 후 신규 발행 권장)\n`;

    const nextStepHint =
      args.create_action_issues === true
        ? ""
        : "\n다음 단계:\n" +
          "  apply_meeting_to_backlog 도구를 인자 없이(invoker_id만) 호출하면\n" +
          "  방금 수집한 회의 댓글을 분석해 새 액션 발행과 명시적인 기존 이슈 변경을 제안할 수 있다.\n";

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
            actionLine +
            jiraLine +
            `  스프린트: ${sprintInfo}\n` +
            `  완료 처리: ${completedResults.length > 0 ? completedResults.join(", ") : "없음"}\n` +
            `  락 ID: ${acquired.id} (TTL ${acquired.expiresAt})` +
            nextStepHint,
        },
      ],
    };
  } finally {
    await lock.release(acquired.id).catch((e) => {
      console.error("[team-mcp] lock release failed:", e);
    });
  }
}
