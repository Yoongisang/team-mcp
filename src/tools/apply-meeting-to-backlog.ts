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

/** pendingBacklogApproval TTL (24시간). */
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

const ProposalSchema = z.object({
  issueKey: z.string().min(1).optional(),
  action: z.enum([
    "create",
    "assign",
    "schedule",
    "move_to_sprint",
    "comment_only",
    "reopen",
  ]),
  summary: z.string().min(1).optional(),
  issueType: z.string().optional(),
  labels: z.array(z.string()).optional(),
  assigneeName: z.string().optional(),
  startDate: z.string().optional(),
  dueDate: z.string().optional(),
  sprintId: z.number().int().optional(),
  comment: z.string().optional(),
}).superRefine((p, ctx) => {
  if (p.action === "create") {
    if (!p.summary) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["summary"],
        message: "create action requires summary",
      });
    }
    return;
  }
  if (p.action === "comment_only" && !p.comment) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["comment"],
      message: "comment_only action requires comment",
    });
  }
  if (!p.issueKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["issueKey"],
      message: `${p.action} action requires issueKey`,
    });
  }
});

const Args = z.object({
  invoker_id: z.string().min(1),
  proposals: z.array(ProposalSchema).optional(),
  confirm: z.boolean().optional(),
  preview_thread_id: z.string().optional(),
});

export const applyMeetingToBacklogTool: Tool = {
  name: "apply_meeting_to_backlog",
  description:
    "PM/팀장 전용. 회의 댓글을 분석해 새로 결정된 실행 항목은 기본적으로 새 Jira 이슈로 생성하고, " +
    "기존 이슈의 담당자·기한·스프린트·상태를 명시적으로 바꾸기로 한 경우에만 기존 이슈를 수정한다. " +
    "3단계 호출:\n" +
    "  [Phase 1] 인자 없이(invoker_id만) 호출 → 백로그 전체 + 회의 댓글 컨텍스트 반환. LLM은 이를 분석해 proposals 작성.\n" +
    "  [Phase 2] proposals 인자 전달 → Discord 정리 스레드에 미리보기 게시. state에 승인 대기 저장.\n" +
    "  [Phase 3] confirm: true 전달 → 일괄 적용. invoker_id가 ALLOWED_USERS면 즉시 적용 (텍스트 명령 승인).\n" +
    "create/schedule 액션에 dueDate가 있으면 자동으로 해당 마감일을 포함하는 스프린트로 이동시킨다 (별도 move_to_sprint 불필요). " +
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
          "각 항목은 action(create/assign/schedule/move_to_sprint/comment_only/reopen)을 가진다. " +
          "새 실행 작업은 기존 이슈와 관련이 있어도 create + summary가 기본이다. " +
          "기존 이슈 변경은 회의에서 해당 이슈의 속성 변경을 명시한 경우에만 issueKey를 사용한다. " +
          "필요 필드는 action별로 다름: create→summary/dueDate/startDate, assign→assigneeName, schedule→dueDate/startDate, " +
          "move_to_sprint→sprintId, comment_only→comment.",
        items: {
          type: "object",
          properties: {
            issueKey: { type: "string", description: "기존 Jira 이슈 키. 예: LIU-9. create 액션에서는 생략." },
            action: {
              type: "string",
              enum: [
                "create",
                "assign",
                "schedule",
                "move_to_sprint",
                "comment_only",
                "reopen",
              ],
            },
            summary: {
              type: "string",
              description: "create 액션으로 새 Jira 이슈를 만들 때 사용할 제목.",
            },
            issueType: {
              type: "string",
              description: "create 액션의 Jira 이슈 타입. 기본값은 JIRA_TASK_TYPE 또는 Task.",
            },
            labels: {
              type: "array",
              items: { type: "string" },
              description: "create 액션에서 추가할 Jira label 목록.",
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
              description:
                "회의 출처/맥락. create에서는 새 이슈 description으로 사용한다. " +
                "comment_only는 사용자가 기존 이슈에 기록만 남기라고 명시한 경우에만 사용한다.",
            },
          },
          required: ["action"],
          additionalProperties: false,
        },
      },
      confirm: {
        type: "boolean",
        description:
          "[Phase 3 전용] true이면 state의 pendingBacklogApproval을 적용. " +
          "PM/팀장이 미리보기를 확인한 뒤 텍스트 명령으로 호출.",
      },
      preview_thread_id: {
        type: "string",
        description:
          "[Phase 2 선택] 기존 백로그 업데이트 미리보기 스레드 ID. 전달하면 새 포럼 포스트 대신 해당 스레드 댓글로 미리보기를 게시.",
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
      const issue = p.issueKey ? issueMap.get(p.issueKey) : undefined;
      const meta = issue ? ` (${issue.status}) ${issue.summary}` : "";
      const keyLabel = p.action === "create"
        ? `새 이슈: ${p.summary ?? "(제목 없음)"}`
        : `${p.issueKey}${meta}`;
      const parts: string[] = [`${i + 1}. **${keyLabel}**`];
      parts.push(`   액션: \`${p.action}\``);
      if (p.issueKey && !issue && p.action !== "create") {
        parts.push("   주의: 현재 Jira 목록에서 찾지 못한 이슈 키입니다.");
      }
      if (p.summary && p.action !== "create") parts.push(`   제목: ${p.summary}`);
      if (p.issueType) parts.push(`   이슈 타입: ${p.issueType}`);
      if (p.labels?.length) parts.push(`   라벨: ${p.labels.join(", ")}`);
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

    // 텍스트 명령 승인 방식:
    // checkPermission(args.invoker_id, ...)가 함수 진입 시 이미 호출됐으므로,
    // confirm: true로 도달한 이상 invoker는 ALLOWED_USERS 멤버임이 보장됨.
    // ✅ reaction 조회 단계는 제거 — 사용자가 "백로그 변경 확정해줘" 등 텍스트로 직접 호출.
    const approverId = args.invoker_id;

    // 적용 시작
    const results: string[] = [];
    const failures: string[] = [];

    const requireIssueKey = (p: BacklogProposal): string => {
      if (!p.issueKey) throw new Error(`${p.action} 액션은 issueKey가 필요합니다`);
      return p.issueKey;
    };

    const moveToSprintForDueDate = async (
      issueKey: string,
      dueDate: string | undefined,
      parts: string[],
    ) => {
      if (!dueDate) return;
      try {
        const boardId = await jira.getBoardId(jiraProject);
        if (boardId === null) return;
        const today = new Date().toISOString().slice(0, 10);
        const sprintId = await jira.getOrCreateSprintByEndDate(
          boardId,
          dueDate,
          today,
        );
        if (sprintId !== null) {
          await jira.moveIssuesToSprint(sprintId, [issueKey]);
          parts.push(`스프린트 자동 배정(id=${sprintId})`);
        }
      } catch (e) {
        console.error(
          `[apply_meeting_to_backlog] auto-sprint failed for ${issueKey}:`,
          e,
        );
      }
    };

    for (const p of pending.proposals) {
      try {
        switch (p.action) {
          case "create": {
            if (!p.summary) throw new Error("summary 누락");
            const issue = await jira.createIssue({
              projectKey: jiraProject,
              summary: p.summary,
              description: p.comment ? `[회의] ${p.comment}` : undefined,
              issueType: p.issueType ?? config.jira.taskType,
              labels: ["scrum-action-item", ...(p.labels ?? [])],
              startDate: p.startDate,
              dueDate: p.dueDate,
            });
            const parts: string[] = [`생성 ${issue.url}`];
            if (p.startDate) parts.push(`시작 ${p.startDate}`);
            if (p.dueDate) parts.push(`기한 ${p.dueDate}`);

            if (p.assigneeName) {
              try {
                const user = await jira.findUserByDisplayName(
                  p.assigneeName,
                  jiraProject,
                );
                if (!user) {
                  parts.push(`담당자 매칭 실패(${p.assigneeName})`);
                } else {
                  await jira.updateIssue(issue.key, {
                    assigneeAccountId: user.accountId,
                  });
                  parts.push(`담당자 ${user.displayName}`);
                }
              } catch (e) {
                parts.push(`담당자 적용 실패(${p.assigneeName}: ${e})`);
              }
            }

            if (p.sprintId) {
              await jira.moveIssuesToSprint(p.sprintId, [issue.key]);
              parts.push(`스프린트 ${p.sprintId}`);
            } else {
              await moveToSprintForDueDate(issue.key, p.dueDate, parts);
            }

            results.push(`${issue.key} → ${parts.join(", ")}`);
            break;
          }
          case "assign": {
            const issueKey = requireIssueKey(p);
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
            await jira.updateIssue(issueKey, {
              assigneeAccountId: user.accountId,
            });
            results.push(`${issueKey} → 담당자 ${user.displayName}`);
            break;
          }
          case "schedule": {
            const issueKey = requireIssueKey(p);
            await jira.updateIssue(issueKey, {
              startDate: p.startDate,
              dueDate: p.dueDate,
            });
            const parts: string[] = [];
            if (p.startDate) parts.push(`시작 ${p.startDate}`);
            if (p.dueDate) parts.push(`기한 ${p.dueDate}`);

            if (p.sprintId) {
              await jira.moveIssuesToSprint(p.sprintId, [issueKey]);
              parts.push(`스프린트 ${p.sprintId}`);
            } else if (p.dueDate) {
              await moveToSprintForDueDate(issueKey, p.dueDate, parts);
            }

            results.push(`${issueKey} → ${parts.join(", ") || "(변경 없음)"}`);
            break;
          }
          case "move_to_sprint": {
            const issueKey = requireIssueKey(p);
            if (!p.sprintId) throw new Error("sprintId 누락");
            await jira.moveIssuesToSprint(p.sprintId, [issueKey]);
            results.push(`${issueKey} → 스프린트 ${p.sprintId}`);
            break;
          }
          case "reopen": {
            const issueKey = requireIssueKey(p);
            const transitioned = await jira.transitionIssueToInProgress(
              issueKey,
            );
            results.push(`${issueKey} → ${transitioned} 재오픈`);
            break;
          }
          case "comment_only": {
            const issueKey = requireIssueKey(p);
            if (!p.comment) throw new Error("comment 누락");
            await jira.addComment(issueKey, `[회의] ${p.comment}`);
            results.push(`${issueKey} → 코멘트만`);
            break;
          }
        }
      } catch (e) {
        const label = p.issueKey ?? p.summary ?? "새 이슈";
        failures.push(`${label} (${p.action}): ${e}`);
      }
    }

    // 결과를 Discord 정리 스레드에 게시
    const resultBody = [
      `## 백로그 업데이트 적용 완료`,
      `확정자 ID: ${approverId}`,
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
            `  확정자 ID: ${approverId}\n` +
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
      `**검토 후 PM/팀장은 "백로그 변경 확정해줘" 라고 명령해주세요.** 권한 있는 사용자만 확정 가능합니다.`,
      "",
      renderProposalsPreview(args.proposals, issueMap),
      "",
      "---",
      `_24시간 내 확정 명령이 없으면 만료됩니다._`,
    ].join("\n");

    const forum = await discord.getChannel(forumId);
    const [summaryTagId] = resolveForumTagIds(forum, [
      config.discord.tagSummary,
    ]);

    const sourceThreadId =
      state.currentMeetingThreadId ?? state.lastFinishedMeetingThreadId;
    const canReuseStoredPreview =
      !!sourceThreadId &&
      state.lastBacklogPreviewSourceThreadId === sourceThreadId;
    const requestedThreadId =
      args.preview_thread_id ??
      (canReuseStoredPreview ? state.pendingBacklogApproval?.threadId : undefined) ??
      (canReuseStoredPreview ? state.lastBacklogPreviewThreadId : undefined);

    let previewThreadId: string;
    let previewThreadName: string;
    let previewMessageIds: string[];
    let postedAsReply = false;

    if (requestedThreadId) {
      try {
        const existingThread = await discord.getChannel(requestedThreadId);
        previewMessageIds = await discord.postChunked(requestedThreadId, previewBody);
        previewThreadId = requestedThreadId;
        previewThreadName = existingThread.name ?? requestedThreadId;
        postedAsReply = true;
      } catch (e) {
        console.error(
          `[apply_meeting_to_backlog] preview thread reuse failed (${requestedThreadId}); creating a new preview thread:`,
          e,
        );
        const { thread, followupMessageIds } = await discord.createForumThread(
          forumId,
          `백로그 업데이트 미리보기 ${today}`,
          previewBody,
          [summaryTagId!],
        );
        previewThreadId = thread.id;
        previewThreadName = thread.name;
        previewMessageIds = followupMessageIds.length > 0
          ? followupMessageIds
          : [thread.id];
      }
    } else {
      const { thread, followupMessageIds } = await discord.createForumThread(
        forumId,
        `백로그 업데이트 미리보기 ${today}`,
        previewBody,
        [summaryTagId!],
      );
      previewThreadId = thread.id;
      previewThreadName = thread.name;
      previewMessageIds = followupMessageIds.length > 0
        ? followupMessageIds
        : [thread.id];
    }

    // 메시지 ID는 추적용으로 보관 (향후 결과 게시 위치 등에 활용 가능).
    // ✅ 리액션 자동 부착은 제거 — 텍스트 명령 승인 방식으로 전환.
    const previewMessageId = previewMessageIds[previewMessageIds.length - 1]!;

    // state에 승인 대기 저장
    const pending: PendingBacklogApproval = {
      threadId: previewThreadId,
      messageId: previewMessageId,
      proposals: args.proposals,
      createdAt: new Date().toISOString(),
    };
    state.pendingBacklogApproval = pending;
    state.lastBacklogPreviewThreadId = previewThreadId;
    state.lastBacklogPreviewSourceThreadId = sourceThreadId ?? null;
    await saveState(state);

    return {
      content: [
        {
          type: "text" as const,
          text:
            `📋 미리보기 게시 완료\n` +
            `  방식: ${postedAsReply ? "기존 미리보기 스레드 댓글" : "새 미리보기 스레드"}\n` +
            `  Discord 스레드: ${previewThreadName} (${previewThreadId})\n` +
            `  제안 수: ${args.proposals.length}건\n\n` +
            `다음 단계:\n` +
            `  1. PM/팀장이 "백로그 변경 확정해줘" 라고 명령\n` +
            `  2. 자동으로 일괄 적용 + 결과 게시 (스케줄 액션은 마감일 기준 스프린트로 자동 배정)\n\n` +
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
  const rawMessages = await discord.listAllMessages(threadId, 1000);
  const messages = rawMessages
    .filter((m) => m.author && !m.author.bot)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  // 백로그 + 스프린트 전체 fetch
  const issues = await jira.listAllIssues(jiraProject);

  // 컨텍스트 텍스트 빌드
  // 의도적으로 현재 담당자(`@assigneeName`)는 표시하지 않음 —
  // 회의 액션 아이템과 백로그 이슈 매칭은 **작업 내용(summary)** 만을 근거로 해야 함.
  // 기존 담당자가 누구인지가 매칭 신호로 들어가면 "X가 작업 중인 항목" 식의 편향이 생김.
  const issueLines = issues
    .map((i) => {
      const sprintTag = i.sprintName ? ` [SP:${i.sprintName}]` : " [Backlog]";
      const epicTag = i.parentKey ? ` (Epic:${i.parentKey})` : "";
      const dueTag = i.dueDate ? ` due:${i.dueDate}` : "";
      return `${i.key} [${i.status}]${sprintTag}${epicTag}${dueTag} — ${i.summary}`;
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
    "포맷: `KEY [상태] [SP:스프린트 또는 Backlog] (Epic:부모) due:기한 — 요약`",
    "_현재 담당자 정보는 의도적으로 표시되지 않음 — 매칭은 오직 작업 내용(summary)으로만 판단._",
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
    '    { "issueKey": "LIU-9", "action": "assign", "assigneeName": "김민수" },',
    '    { "issueKey": "LIU-15", "action": "schedule", "dueDate": "2026-05-20" },',
    '    { "issueKey": "LIU-22", "action": "move_to_sprint", "sprintId": 1 },',
    '    { "issueKey": "LIU-30", "action": "reopen" },',
    '    { "action": "create", "summary": "신규 락온 UI 피드백 반영",',
    '      "dueDate": "2026-05-20", "assigneeName": "김민수",',
    '      "comment": "회의에서 새 작업으로 확인됨" }',
    "  ]",
    "}",
    "```",
    "",
    "분석 가이드:",
    "  - **새로 수행해야 하는 작업·후속 조치·피드백 반영·추가 수정은 기본적으로 `create`.** 관련된 기존 이슈가 있어도 댓글로 대체하지 말고 독립된 새 액션 이슈를 발행하라.",
    "  - `assign`, `schedule`, `move_to_sprint`, `reopen`은 회의에서 기존 이슈 자체의 담당자·일정·스프린트·상태를 바꾸기로 명확히 결정한 경우에만 사용하라.",
    "  - `comment_only`는 사용자가 '기존 이슈에 기록만 남겨라'라고 명시한 경우에만 사용한다. 실행할 일이 포함된 발화에는 사용하지 말 것.",
    "  - 기존 이슈를 수정할 때의 매칭 기준은 작업 내용(summary)뿐이다. 현재 담당자나 발화자는 매칭 신호로 사용하지 말 것.",
    "  - 회의에서 명확히 결정된 작업만 proposal로 만들고, 모호하면 제외.",
    "  - 동일 이슈에 여러 변경이 있으면 여러 proposal로 분할 (예: 담당자+기한 = assign + schedule 2건).",
    "  - `assign` 액션의 assigneeName은 회의에서 **명시적으로 누가 맡기로 했는지** 발화된 경우에만 채울 것.",
    "    누가 맡았는지 회의에 언급이 없으면 assign 액션 자체를 만들지 말 것 (현재 담당자 추정 금지).",
    "  - **`create` 또는 `schedule` 액션에 dueDate를 넣으면 서버가 자동으로 그 마감일에 맞는 스프린트로 이동시킴.**",
    "    별도로 `move_to_sprint` proposal을 만들 필요 없음. dueDate만 정확히 추출하면 됨.",
    "    새 작업에 마감일이 있으면 `create`에 dueDate를 넣고, 기존 이슈의 마감일 변경일 때만 `schedule`을 사용하라.",
    "  - `move_to_sprint`는 마감일 변경 없이 다른 스프린트로 이동시킬 때만 사용 (드문 케이스).",
    "  - `create` proposal의 `comment`에는 회의 출처를 넣어 새 이슈 description으로 남겨라.",
    "  - 완료 이슈의 상태 자체를 다시 진행으로 돌리기로 했으면 `reopen`. 별도 추가 작업이나 재작업이면 새 `create` 이슈를 발행하라.",
    "",
    "재호출 시 Phase 2가 실행되어 Discord 정리 스레드에 미리보기를 게시하고 PM/팀장의 텍스트 확정을 대기한다.",
  ].join("\n");

  return { content: [{ type: "text" as const, text }] };
}
