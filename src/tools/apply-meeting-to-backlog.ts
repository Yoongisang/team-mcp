import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { config, requireConfig } from "../config.js";
import {
  DiscordClient,
  resolveForumTagIds,
  type DiscordMessage,
} from "../lib/discord.js";
import { JiraClient } from "../lib/jira.js";
import { checkPermission } from "../lib/safety.js";
import {
  loadState,
  saveState,
  type BacklogProposal,
  type PendingBacklogApproval,
} from "../lib/state.js";

/** 사용자가 누를 승인 이모지. Discord API에 보낼 때 유니코드 그대로. */
const APPROVAL_EMOJI = "✅";
/** pendingBacklogApproval TTL (24시간). */
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

const ProposalSchema = z.object({
  issueKey: z.string().min(1),
  action: z.enum([
    "assign",
    "schedule",
    "move_to_sprint",
    "comment_only",
    "reopen",
  ]),
  assigneeName: z.string().optional(),
  startDate: z.string().optional(),
  dueDate: z.string().optional(),
  sprintId: z.number().int().optional(),
  comment: z.string().optional(),
});

const Args = z.object({
  invoker_id: z.string().min(1),
  proposals: z.array(ProposalSchema).optional(),
  confirm: z.boolean().optional(),
});

export const applyMeetingToBacklogTool: Tool = {
  name: "apply_meeting_to_backlog",
  description:
    "PM/팀장 전용. 회의 댓글을 분석해 기존 Jira 백로그/스프린트 작업에 변경사항(담당자·기한·스프린트·코멘트·재오픈)을 적용. " +
    "3단계 호출:\n" +
    "  [Phase 1] 인자 없이(invoker_id만) 호출 → 백로그 전체 + 회의 댓글 컨텍스트 반환. LLM은 이를 분석해 proposals 작성.\n" +
    "  [Phase 2] proposals 인자 전달 → Discord 정리 스레드에 미리보기 게시 + ✅ reaction 대기. state에 승인 대기 저장.\n" +
    "  [Phase 3] confirm: true 전달 → 저장된 메시지의 ✅ reaction 확인 후 일괄 적용. ALLOWED_USERS만 승인 가능.\n" +
    "회의 종료 후 finish_meeting 다음에 호출하며, 회의 스레드는 state.currentMeetingThreadId 기준. " +
    "finish_meeting이 이미 currentMeetingThreadId를 클리어했다면 state.lastPrepareMeetingAt 흔적이 없으니 사용자에게 prepare → finish 순으로 재진행을 안내한다.",
  inputSchema: {
    type: "object",
    properties: {
      invoker_id: {
        type: "string",
        description:
          "호출자 Discord user ID (snowflake). ALLOWED_USERS 검증 대상.",
      },
      proposals: {
        type: "array",
        description:
          "[Phase 2 전용] LLM이 회의 분석 후 작성한 변경 제안 목록. " +
          "각 항목은 issueKey + action(assign/schedule/move_to_sprint/comment_only/reopen). " +
          "필요 필드는 action별로 다름: assign→assigneeName, schedule→dueDate/startDate, " +
          "move_to_sprint→sprintId, comment_only/reopen→comment.",
        items: {
          type: "object",
          properties: {
            issueKey: { type: "string", description: "예: LIU-9" },
            action: {
              type: "string",
              enum: [
                "assign",
                "schedule",
                "move_to_sprint",
                "comment_only",
                "reopen",
              ],
            },
            assigneeName: {
              type: "string",
              description: "Jira 사용자 표시명 (예: '김민수'). MCP가 accountId 조회.",
            },
            startDate: { type: "string", description: "YYYY-MM-DD" },
            dueDate: { type: "string", description: "YYYY-MM-DD" },
            sprintId: { type: "number" },
            comment: {
              type: "string",
              description: "회의 출처/맥락. 모든 액션에 코멘트 부착 권장.",
            },
          },
          required: ["issueKey", "action"],
          additionalProperties: false,
        },
      },
      confirm: {
        type: "boolean",
        description:
          "[Phase 3 전용] true이면 state의 pendingBacklogApproval을 적용. " +
          "사용자가 Discord 미리보기 메시지에 ✅을 누른 뒤 호출.",
      },
    },
    required: ["invoker_id"],
    additionalProperties: false,
  },
};

function formatMessage(m: DiscordMessage): string {
  const ts = m.timestamp.slice(0, 19).replace("T", " ");
  return `[${ts}] @${m.author.username}: ${m.content}`;
}

function renderProposalsPreview(
  proposals: BacklogProposal[],
  issueMap: Map<string, { summary: string; status: string }>,
): string {
  if (proposals.length === 0) return "(제안 없음)";
  return proposals
    .map((p, i) => {
      const issue = issueMap.get(p.issueKey);
      const meta = issue ? ` (${issue.status}) ${issue.summary}` : "";
      const parts: string[] = [`${i + 1}. **${p.issueKey}**${meta}`];
      parts.push(`   액션: \`${p.action}\``);
      if (p.assigneeName) parts.push(`   담당자: ${p.assigneeName}`);
      if (p.startDate) parts.push(`   시작일: ${p.startDate}`);
      if (p.dueDate) parts.push(`   기한: ${p.dueDate}`);
      if (p.sprintId) parts.push(`   스프린트 ID: ${p.sprintId}`);
      if (p.comment) parts.push(`   코멘트: ${p.comment.slice(0, 120)}`);
      return parts.join("\n");
    })
    .join("\n\n");
}

export async function applyMeetingToBacklog(raw: unknown) {
  const args = Args.parse(raw);
  checkPermission(args.invoker_id, config.allowedUsers);

  const token = requireConfig(config.discord.botToken, "DISCORD_BOT_TOKEN");
  const forumId = requireConfig(
    config.discord.scrumChannelId,
    "DISCORD_SCRUM_CHANNEL_ID",
  );
  const jiraToken = requireConfig(config.jira.apiToken, "JIRA_API_TOKEN");
  const jiraEmail = requireConfig(config.jira.email, "JIRA_EMAIL");
  const jiraHost = requireConfig(config.jira.host, "JIRA_HOST");
  const jiraProject = requireConfig(
    config.jira.projectKey,
    "JIRA_PROJECT_KEY",
  );

  const discord = new DiscordClient(token);
  const jira = new JiraClient(jiraHost, jiraEmail, jiraToken);
  const state = await loadState();

  // ── Phase 3: 적용 ───────────────────────────────────────────────────
  if (args.confirm === true) {
    const pending = state.pendingBacklogApproval;
    if (!pending) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              "승인 대기 중인 항목이 없습니다. 먼저 proposals를 보내 Phase 2를 실행하세요.",
          },
        ],
      };
    }

    // 24시간 만료 확인
    const ageMs = Date.now() - Date.parse(pending.createdAt);
    if (ageMs > APPROVAL_TTL_MS) {
      state.pendingBacklogApproval = null;
      await saveState(state);
      return {
        content: [
          {
            type: "text" as const,
            text: "승인 대기가 24시간을 초과해 만료되었습니다. 처음부터 다시 진행하세요.",
          },
        ],
      };
    }

    // Discord 메시지의 ✅ reaction 조회
    let reactors: Array<{ id: string; username: string }>;
    try {
      reactors = await discord.getReactionUsers(
        pending.threadId,
        pending.messageId,
        APPROVAL_EMOJI,
      );
    } catch (e) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Discord reaction 조회 실패: ${e}\n메시지가 삭제되었거나 권한이 없을 수 있습니다.`,
          },
        ],
      };
    }

    const approverIds = new Set(config.allowedUsers);
    const approvers = reactors.filter((u) => approverIds.has(u.id));
    if (approvers.length === 0) {
      const reactorList =
        reactors.length === 0
          ? "(아무도 누르지 않음)"
          : reactors.map((u) => `@${u.username}`).join(", ");
      return {
        content: [
          {
            type: "text" as const,
            text:
              `아직 권한 있는 사용자의 승인이 없습니다.\n` +
              `현재 ${APPROVAL_EMOJI} 누른 사람: ${reactorList}\n` +
              `ALLOWED_USERS 중 한 명이 Discord 미리보기 메시지에 ${APPROVAL_EMOJI}을 누른 뒤 다시 호출하세요.`,
          },
        ],
      };
    }

    // 적용 시작
    const results: string[] = [];
    const failures: string[] = [];

    for (const p of pending.proposals) {
      try {
        switch (p.action) {
          case "assign": {
            if (!p.assigneeName) {
              throw new Error("assigneeName 누락");
            }
            const user = await jira.findUserByDisplayName(
              p.assigneeName,
              jiraProject,
            );
            if (!user) {
              throw new Error(`사용자 '${p.assigneeName}' 못 찾음`);
            }
            await jira.updateIssue(p.issueKey, {
              assigneeAccountId: user.accountId,
            });
            results.push(`${p.issueKey} → 담당자 ${user.displayName}`);
            break;
          }
          case "schedule": {
            await jira.updateIssue(p.issueKey, {
              startDate: p.startDate,
              dueDate: p.dueDate,
            });
            const parts: string[] = [];
            if (p.startDate) parts.push(`시작 ${p.startDate}`);
            if (p.dueDate) parts.push(`기한 ${p.dueDate}`);
            results.push(`${p.issueKey} → ${parts.join(", ") || "(변경 없음)"}`);
            break;
          }
          case "move_to_sprint": {
            if (!p.sprintId) throw new Error("sprintId 누락");
            await jira.moveIssuesToSprint(p.sprintId, [p.issueKey]);
            results.push(`${p.issueKey} → 스프린트 ${p.sprintId}`);
            break;
          }
          case "reopen": {
            const transitioned = await jira.transitionIssueToInProgress(
              p.issueKey,
            );
            results.push(`${p.issueKey} → ${transitioned} 재오픈`);
            break;
          }
          case "comment_only":
            // 코멘트만 부착 (아래 공통 처리)
            results.push(`${p.issueKey} → 코멘트만`);
            break;
        }

        // 모든 액션에 코멘트 부착 (있을 때)
        if (p.comment) {
          await jira.addComment(p.issueKey, `[회의] ${p.comment}`);
        }
      } catch (e) {
        failures.push(`${p.issueKey} (${p.action}): ${e}`);
      }
    }

    // 결과를 Discord 정리 스레드에 게시
    const resultBody = [
      `## 백로그 업데이트 적용 완료`,
      `승인자: ${approvers.map((u) => `@${u.username}`).join(", ")}`,
      "",
      `### 성공 (${results.length}건)`,
      results.length > 0 ? results.map((r) => `- ${r}`).join("\n") : "(없음)",
      ...(failures.length > 0
        ? [
            "",
            `### 실패 (${failures.length}건)`,
            failures.map((f) => `- ${f}`).join("\n"),
          ]
        : []),
    ].join("\n");

    try {
      await discord.postChunked(pending.threadId, resultBody);
    } catch (e) {
      // Discord 게시 실패는 치명적이지 않음 — 결과는 LLM 응답으로도 반환
      console.error("[apply_meeting_to_backlog] discord post failed:", e);
    }

    // 정리
    state.pendingBacklogApproval = null;
    await saveState(state);

    return {
      content: [
        {
          type: "text" as const,
          text:
            `✅ 적용 완료\n` +
            `  승인자: ${approvers.map((u) => `@${u.username}`).join(", ")}\n` +
            `  성공: ${results.length}건\n` +
            `  실패: ${failures.length}건\n\n` +
            (results.length > 0
              ? `[성공]\n${results.map((r) => `  - ${r}`).join("\n")}\n`
              : "") +
            (failures.length > 0
              ? `[실패]\n${failures.map((f) => `  - ${f}`).join("\n")}\n`
              : ""),
        },
      ],
    };
  }

  // ── Phase 2: 미리보기 게시 + 승인 대기 ─────────────────────────────
  if (args.proposals && args.proposals.length > 0) {
    if (!state.currentMeetingThreadId && !state.lastPrepareMeetingAt) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              "회의 컨텍스트가 없습니다. prepare_meeting → finish_meeting → apply_meeting_to_backlog 순서로 진행하세요.",
          },
        ],
      };
    }

    // 미리보기용으로 현재 백로그 status/summary 한 번 더 가져옴 (선택적)
    let issueMap = new Map<string, { summary: string; status: string }>();
    try {
      const all = await jira.listAllIssues(jiraProject);
      issueMap = new Map(
        all.map((i) => [i.key, { summary: i.summary, status: i.status }]),
      );
    } catch (e) {
      console.error("[apply_meeting_to_backlog] backlog refetch failed:", e);
    }

    const today = new Date().toISOString().slice(0, 10);
    const previewBody = [
      `# 📋 백로그 업데이트 미리보기 (${today})`,
      "",
      `회의에서 다음 ${args.proposals.length}건의 변경을 제안합니다.`,
      `**검토 후 이 메시지에 ${APPROVAL_EMOJI} 를 눌러주세요.** 권한 있는 사용자(PM/팀장)의 ${APPROVAL_EMOJI} 1개로 일괄 적용됩니다.`,
      "",
      renderProposalsPreview(args.proposals, issueMap),
      "",
      "---",
      `_24시간 내 ${APPROVAL_EMOJI} 없으면 만료됩니다._`,
    ].join("\n");

    // 정리 스레드를 찾아서 게시. finish_meeting이 직전에 정리 스레드를 만들었지만
    // 스레드 ID를 state에 저장하지 않으므로, 가장 최근의 [정리] 태그 스레드를
    // 찾는 대신 currentMeetingThreadId(이미 닫힘) 또는 forum에 직접 새 스레드 생성.
    // 가장 단순한 안전책: 포럼에 [정리] 태그로 새 스레드 생성.
    const forum = await discord.getChannel(forumId);
    const [summaryTagId] = resolveForumTagIds(forum, [
      config.discord.tagSummary,
    ]);

    const { thread, followupMessageIds } = await discord.createForumThread(
      forumId,
      `백로그 업데이트 미리보기 ${today}`,
      previewBody,
      [summaryTagId!],
    );

    // 첫 메시지(스레드의 첫 메시지)에 ✅ 미리 달아두기 — 스레드 ID == 첫 메시지 ID
    // Discord 포럼: 스레드 생성 시 본문은 thread.id와 동일 ID의 메시지로 들어감
    const previewMessageId =
      followupMessageIds.length > 0
        ? followupMessageIds[followupMessageIds.length - 1]!
        : thread.id;

    try {
      await discord.addReaction(thread.id, previewMessageId, APPROVAL_EMOJI);
    } catch (e) {
      console.error("[apply_meeting_to_backlog] addReaction failed:", e);
    }

    // state에 승인 대기 저장
    const pending: PendingBacklogApproval = {
      threadId: thread.id,
      messageId: previewMessageId,
      proposals: args.proposals,
      createdAt: new Date().toISOString(),
    };
    state.pendingBacklogApproval = pending;
    await saveState(state);

    return {
      content: [
        {
          type: "text" as const,
          text:
            `📋 미리보기 게시 완료\n` +
            `  Discord 스레드: ${thread.name} (${thread.id})\n` +
            `  메시지 ID: ${previewMessageId}\n` +
            `  제안 수: ${args.proposals.length}건\n\n` +
            `다음 단계:\n` +
            `  1. PM/팀장이 Discord 스레드에서 ${APPROVAL_EMOJI} 클릭\n` +
            `  2. 클릭 후 'apply_meeting_to_backlog confirm:true' 호출\n` +
            `  3. 자동으로 일괄 적용 + 결과 게시\n\n` +
            `_24시간 후 자동 만료._`,
        },
      ],
    };
  }

  // ── Phase 1: 컨텍스트 반환 ─────────────────────────────────────────
  // currentMeetingThreadId 우선, 없으면 lastFinishedMeetingThreadId 사용
  // (finish_meeting 직후 호출되는 일반적인 경우 대응)
  const threadId =
    state.currentMeetingThreadId ?? state.lastFinishedMeetingThreadId;
  if (!threadId) {
    return {
      content: [
        {
          type: "text" as const,
          text:
            "회의 스레드를 찾을 수 없습니다.\n" +
            "prepare_meeting → (회의 진행) → finish_meeting → apply_meeting_to_backlog 순서로 진행하세요.\n" +
            "또는 직전 회의 사이클의 lastFinishedMeetingThreadId가 다음 prepare_meeting으로 덮였을 수 있습니다.",
        },
      ],
    };
  }
  const rawMessages = await discord.listMessages(threadId, { limit: 100 });
  const messages = rawMessages
    .filter((m) => m.author && !m.author.username.endsWith("[BOT]"))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  // 백로그 + 스프린트 전체 fetch
  const issues = await jira.listAllIssues(jiraProject);

  // 컨텍스트 텍스트 빌드
  const issueLines = issues
    .map((i) => {
      const sprintTag = i.sprintName ? ` [SP:${i.sprintName}]` : " [Backlog]";
      const epicTag = i.parentKey ? ` (Epic:${i.parentKey})` : "";
      const assignTag = i.assigneeName ? ` @${i.assigneeName}` : "";
      const dueTag = i.dueDate ? ` due:${i.dueDate}` : "";
      return `${i.key} [${i.status}]${sprintTag}${epicTag}${assignTag}${dueTag} — ${i.summary}`;
    })
    .join("\n");

  const messageBlock =
    messages.length === 0
      ? "(수집된 댓글 없음)"
      : messages.map(formatMessage).join("\n");

  const text = [
    "# apply_meeting_to_backlog — 분석 컨텍스트",
    `_스레드: ${threadId}, 댓글 ${messages.length}건, 백로그 ${issues.length}건._`,
    "",
    "## Jira 이슈 전체 (백로그 + 스프린트)",
    "포맷: `KEY [상태] [SP:스프린트 또는 Backlog] (Epic:부모) @담당자 due:기한 — 요약`",
    "",
    issueLines || "(이슈 없음)",
    "",
    "## 회의 스레드 댓글",
    messageBlock,
    "",
    "---",
    "위 두 정보를 분석해 다음 JSON 스키마의 `proposals` 배열을 만든 뒤 apply_meeting_to_backlog를 다시 호출하라:",
    "",
    "```json",
    "{",
    '  "invoker_id": "...",',
    '  "proposals": [',
    '    { "issueKey": "LIU-9", "action": "assign", "assigneeName": "김민수",',
    '      "comment": "회의 발화 출처/맥락" },',
    '    { "issueKey": "LIU-15", "action": "schedule", "dueDate": "2026-05-20",',
    '      "comment": "..." },',
    '    { "issueKey": "LIU-22", "action": "move_to_sprint", "sprintId": 1, "comment": "..." },',
    '    { "issueKey": "LIU-30", "action": "reopen", "comment": "회의에서 추가 작업 필요로 다시 시작" },',
    '    { "issueKey": "LIU-42", "action": "comment_only", "comment": "진행 노트" }',
    "  ]",
    "}",
    "```",
    "",
    "분석 가이드:",
    "  - 회의에서 명확히 언급된 작업만 매칭하라. 모호하면 제외.",
    "  - 동일 이슈에 여러 변경이 있으면 여러 proposal로 분할 (예: 담당자+기한 = assign + schedule 2건).",
    "  - 모든 proposal에 가능한 한 `comment`를 포함해 회의 출처를 남겨라 (예: '회의 2026-05-13에서 김XX가 맡기로 함').",
    "  - 완료 상태(Done/완료) 이슈가 회의에서 '다시', '추가', '재작업' 등으로 언급되면 `reopen`.",
    "  - 백로그에 없는 신규 작업 요청은 proposals에 넣지 말고, 별도로 사용자에게 '신규 이슈 생성이 필요해 보입니다' 보고.",
    "",
    "재호출 시 Phase 2가 실행되어 Discord 정리 스레드에 미리보기를 게시하고 ✅ reaction을 대기한다.",
  ].join("\n");

  return { content: [{ type: "text" as const, text }] };
}
