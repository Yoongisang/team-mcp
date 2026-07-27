import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { config, requireConfig } from "../config.js";
import { DiscordClient, resolveForumTagIds } from "../lib/discord.js";
import { GAME_FILES, gameFileExists, readGameFile, writeGameFile } from "../lib/files.js";
import { gitPushedLog, gitShowDetails } from "../lib/git.js";
import {
  currentMeetingDate,
  latestInProgressMeeting,
  meetingSequence,
  meetingThreadName,
  nextMeetingSequence,
} from "../lib/meeting-threads.js";
import {
  parseChecklist,
  progress,
  setItemDone,
  joinLines,
} from "../lib/markdown.js";
import { loadState, saveState, type PendingConfirmation } from "../lib/state.js";
import type { Commit } from "../lib/git.js";

export const prepareMeetingTool: Tool = {
  name: "prepare_meeting",
  description:
    "마지막 prepare_meeting 이후의 git 커밋과 체크리스트 진행률을 모아 " +
    "커밋 검토용 컨텍스트를 먼저 반환하고, 사람이 읽기 좋은 요약을 받은 뒤 " +
    "오늘 날짜의 가장 최근 [진행] 회의 스레드에 게시한다. 해당 스레드가 없으면 " +
    "오늘 회차를 계산해 새 회의 스레드를 생성한다. " +
    "커밋과 체크리스트 항목이 부분적으로 일치하면 Discord 포스트 전에 " +
    "사용자에게 확인을 요청한다. confirmed_indexes를 포함해 재호출하면 " +
    "확인 결과를 체크리스트에 반영한다.",
  inputSchema: {
    type: "object",
    properties: {
      user_name: {
        type: "string",
        description:
          "Discord에 표시할 스크럼 보고자 이름. 커밋 필터에는 사용하지 않는다. " +
          "Discord 메시지로 트리거된 경우 메시지 작성자의 표시 이름을 그대로 전달.",
      },
      confirmed_indexes: {
        type: "array",
        items: { type: "number" },
        description:
          "확인 질문에 대한 응답. 완료된 항목의 번호 배열. " +
          "없으면 첫 번째 호출로 간주해 부분 매칭 항목이 있을 경우 질문을 반환한다. " +
          "빈 배열([])은 '모두 아님'으로 처리해 Discord 포스트를 진행한다.",
      },
      commit_summary_markdown: {
        type: "string",
        description:
          "커밋 원문을 검토해 작성한 Discord 게시용 요약. 핵심 변경, 영향 범위, 진행 상태를 사람이 읽기 쉽게 정리한다.",
      },
    },
    required: ["user_name"],
    additionalProperties: false,
  },
};

const Args = z.object({
  user_name: z.string().min(1),
  confirmed_indexes: z.array(z.number()).optional(),
  commit_summary_markdown: z.string().min(1).optional(),
});

// ── 체크리스트 자동완료 ────────────────────────────────────────────────────

/** UE 클래스/에셋명 추출 (GA_, GE_, GC_, AT_, BP_ 등) */
function extractUENames(text: string): string[] {
  return (text.match(/\b[A-Z]{1,4}_[A-Za-z0-9_]+/g) ?? []).map(s => s.toLowerCase());
}

/** 한국어 2자 이상 단어 추출 */
function extractKoreanWords(text: string): string[] {
  return text.match(/[가-힣]{2,}/g) ?? [];
}

/** 영문 4자 이상 단어 추출 */
function extractEnglishWords(text: string): string[] {
  return text.toLowerCase().match(/[a-z]{4,}/g) ?? [];
}

type MatchConfidence = "high" | "partial" | "none";

/**
 * 체크리스트 항목 텍스트가 커밋(subject + body)에 얼마나 매칭되는지 반환.
 * - high  : 자동완료 (UE 클래스명 일치 또는 키워드 70%↑)
 * - partial: 사용자 확인 필요 (키워드 40~69%)
 * - none  : 무관
 */
function commitMatchConfidence(itemText: string, commit: Commit): MatchConfidence {
  const searchText = [
    commit.subject,
    commit.body ?? "",
  ].join(" ").toLowerCase();

  // 1. UE 클래스명 매칭 → high
  const ueNames = extractUENames(itemText);
  if (ueNames.length > 0 && ueNames.some(n => searchText.includes(n))) {
    return "high";
  }

  // 2. 한국어 키워드 매칭
  const koWords = extractKoreanWords(itemText);
  if (koWords.length >= 2) {
    const matched = koWords.filter(w => searchText.includes(w)).length;
    const ratio = matched / koWords.length;
    if (ratio >= 0.7) return "high";
    if (ratio >= 0.4 && matched >= 1) return "partial";
    return "none";
  }

  // 3. 영문 키워드 매칭
  const enWords = extractEnglishWords(itemText);
  if (enWords.length >= 2) {
    const matched = enWords.filter(w => searchText.includes(w)).length;
    const ratio = matched / enWords.length;
    if (ratio >= 0.7) return "high";
    if (ratio >= 0.4 && matched >= 1) return "partial";
  }

  return "none";
}

/** 하위 호환: 고신뢰 매칭 여부만 반환 */
function matchesCommit(itemText: string, commit: Commit): boolean {
  return commitMatchConfidence(itemText, commit) === "high";
}

interface AutoCompleteResult {
  proposals: PendingConfirmation[];
  /**
   * 체크리스트의 어떤 항목과도 매칭되지 않은 커밋들 (none-매칭).
   * 파일에는 자동 반영하지 않고 보고서에 후보로만 노출한다.
   */
  orphanCommits: Commit[];
}

/**
 * 커밋 목록을 체크리스트 항목과 매칭해 완료 후보를 만든다.
 * - 고신뢰 매칭도 즉시 [x] 처리하지 않고 사용자 확인을 기다린다.
 * - 부분 매칭도 사용자 확인 대기 목록에 추가한다.
 * - 어떤 항목과도 매칭 안 됨(none) → orphanCommits 반환
 */
async function autoCompleteFromCommits(
  commits: Commit[],
): Promise<AutoCompleteResult> {
  if (commits.length === 0)
    return { proposals: [], orphanCommits: [] };
  if (!(await gameFileExists(GAME_FILES.checklist)))
    return { proposals: [], orphanCommits: [] };

  const raw = await readGameFile(GAME_FILES.checklist);
  const { items } = parseChecklist(raw);
  const incomplete = items.filter(i => !i.done);

  // 체크리스트에 미완료 항목이 없으면 모든 커밋이 orphan 후보
  // (단, 파일에는 자동 추가하지 않는다.)
  if (incomplete.length === 0) {
    return { proposals: [], orphanCommits: [...commits] };
  }

  const proposals: PendingConfirmation[] = [];
  let pendingIndex = 1;

  // 각 커밋이 어떤 항목과도 매칭(high/partial) 안 됐는지 추적
  const matchedCommitHashes = new Set<string>();

  for (const item of incomplete) {
    let bestConfidence: MatchConfidence = "none";
    let bestCommit: Commit | undefined;

    for (const c of commits) {
      const conf = commitMatchConfidence(item.text, c);
      if (conf !== "none") matchedCommitHashes.add(c.hash);
      if (conf === "high") { bestConfidence = "high"; bestCommit = c; break; }
      if (conf === "partial" && bestConfidence === "none") {
        bestConfidence = "partial";
        bestCommit = c;
      }
    }

    if (bestConfidence === "high") {
      proposals.push({
        index: pendingIndex++,
        itemText: item.text,
        commitSubject: bestCommit?.subject ?? "",
        commitHash: bestCommit?.hash,
        confidence: "high",
      });
    } else if (bestConfidence === "partial" && bestCommit) {
      proposals.push({
        index: pendingIndex++,
        itemText: item.text,
        commitSubject: bestCommit.subject,
        commitHash: bestCommit.hash,
        confidence: "partial",
      });
    }
  }

  // orphan: 어떤 항목과도 매칭(high/partial) 안 된 커밋
  const orphanCommits = commits.filter(c => !matchedCommitHashes.has(c.hash));

  return { proposals, orphanCommits };
}

function renderCommitReviewContext(
  commits: Commit[],
  userName: string,
  gitSource: {
    branch: string;
    upstream: string;
    previousReportedHead: string | null;
    unpushedCount: number;
  },
): string {
  const period = gitSource.previousReportedHead
    ? `이전 보고 HEAD ${gitSource.previousReportedHead.slice(0, 7)} 이후`
    : "최초 수집: 최근 7일";
  const rawCommits = commits
    .map((commit) => {
      const lines = [
        `## ${commit.hash.slice(0, 7)} ${commit.subject}`,
        `- 작성 시각: ${commit.date}`,
      ];
      if (commit.body) lines.push(`- 본문:\n${commit.body}`);
      if (commit.filesChanged !== undefined) {
        lines.push(
          `- 변경량: ${commit.filesChanged} files, +${commit.insertions ?? 0}/-${commit.deletions ?? 0}`,
        );
      }
      if (commit.topFiles?.length) {
        lines.push(`- 주요 파일: ${commit.topFiles.join(", ")}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");

  return [
    "# 스크럼 커밋 요약 작성 컨텍스트",
    `- 보고자: ${userName}`,
    `- Git 기준: ${gitSource.branch} → ${gitSource.upstream}에 반영된 커밋`,
    `- 기간: ${period}`,
    `- 커밋 수: ${commits.length}`,
    `- push되지 않아 제외된 로컬 커밋: ${gitSource.unpushedCount}`,
    "",
    rawCommits,
    "",
    "---",
    "위 커밋들을 검토해 중복·구현 세부 로그는 합치고, 팀원이 빠르게 이해할 수 있는 Markdown 요약을 작성하세요.",
    "요약에는 다음 내용을 포함하세요:",
    "- 핵심 변경 사항",
    "- 영향받는 기능 또는 시스템",
    "- 완료된 부분과 아직 확인이 필요한 부분",
    "- 파일명은 중요한 경우에만 언급",
    "",
    "작성한 요약을 `commit_summary_markdown`에 넣어 prepare_meeting을 다시 호출하세요.",
    "체크리스트 확인 단계를 이미 거쳤다면 `confirmed_indexes: []`도 함께 전달하세요.",
  ].join("\n");
}

export async function prepareMeeting(raw: unknown) {
  const { user_name, confirmed_indexes, commit_summary_markdown } =
    Args.parse(raw);
  const token = requireConfig(config.discord.botToken, "DISCORD_BOT_TOKEN");
  const forumId = requireConfig(
    config.discord.scrumChannelId,
    "DISCORD_SCRUM_CHANNEL_ID",
  );

  const state = await loadState();

  // ── 게임 레포의 현재 upstream에 push된 커밋 수집 ────────────────────
  const pushedLog = await gitPushedLog({
    lastReportedHeads: state.lastReportedUpstreamHeads,
    limit: 200,
  });
  const baseCommits = pushedLog.commits;
  const detailLimit = 10;
  const commits = await Promise.all(
    baseCommits.map(async (c, i) => {
      if (i >= detailLimit) return c;
      try {
        const d = await gitShowDetails(c.hash);
        return { ...c, ...d };
      } catch {
        return c;
      }
    }),
  );

  // ── 2차 호출: confirmed_indexes로 pending 확인 처리 ──────────────────
  const confirmedItems: string[] = [];
  if (confirmed_indexes !== undefined) {
    const pending = state.pendingConfirmations ?? [];
    if (pending.length > 0 && confirmed_indexes.length > 0) {
      const raw_ckl = await readGameFile(GAME_FILES.checklist);
      const { items, lines } = parseChecklist(raw_ckl);
      let updatedLines = lines;
      for (const p of pending) {
        if (!confirmed_indexes.includes(p.index)) continue;
        const target = items.find(i => !i.done && i.text === p.itemText);
        if (target) {
          updatedLines = setItemDone(updatedLines, target, true);
          confirmedItems.push(target.text);
          state.completions.push({
            task: target.text,
            completedAt: new Date().toISOString(),
          });
        }
      }
      if (confirmedItems.length > 0) {
        await writeGameFile(GAME_FILES.checklist, joinLines(updatedLines), { overwrite: true });
      }
    }
    state.pendingConfirmations = [];
    await saveState(state);
  }

  // ── 체크리스트 완료 후보 + orphan 식별 (자동 반영 없음) ───────────────
  const {
    proposals: newPending,
    orphanCommits,
  } = await autoCompleteFromCommits(commits);

  // ── 1차 호출이고 완료 후보가 있으면 → Discord 포스트 전에 질문 반환
  if (confirmed_indexes === undefined && newPending.length > 0) {
    state.pendingConfirmations = newPending;
    await saveState(state);

    const lines = [
      "다음 항목들이 이번 커밋으로 완료된 작업과 같은가요?\n",
      ...newPending.map(p =>
        `**${p.index}.** ${p.itemText} (${p.confidence ?? "partial"})\n   ← \`${p.commitSubject}\``
      ),
      "\n완료된 항목 번호를 `confirmed_indexes`에 담아 다시 호출해주세요.",
      "없으면 빈 배열 `[]`로 호출하면 Discord 포스트로 진행합니다.",
    ];

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  }

  if (commits.length > 0 && !commit_summary_markdown) {
    return {
      content: [
        {
          type: "text" as const,
          text: renderCommitReviewContext(
            commits,
            user_name,
            pushedLog,
          ),
        },
      ],
    };
  }

  const orphanCommitCount = orphanCommits.length;

  // ── 진행률 계산 ──────────────────────────────────────────────────────
  let progressLine = "(체크리스트 없음)";
  if (await gameFileExists(GAME_FILES.checklist)) {
    const ckl = await readGameFile(GAME_FILES.checklist);
    const { items } = parseChecklist(ckl);
    const p = progress(items);
    progressLine = `${p.done}/${p.total} (${(p.ratio * 100).toFixed(1)}%)`;
    const incomplete = items.filter((i) => !i.done);
    if (incomplete.length > 0) {
      const head = incomplete.slice(0, 5).map((i) => i.text).join(", ");
      const more = incomplete.length - 5;
      progressLine += `\n미완료: ${head}${more > 0 ? ` 외 ${more}개` : ""}`;
    }
  }

  // ── Discord 보고 메시지 빌드 ─────────────────────────────────────────
  const periodLabel = pushedLog.previousReportedHead
    ? `이전 push 보고 ${pushedLog.previousReportedHead.slice(0, 7)} 이후`
    : "최초 push 수집: 최근 7일";

  const commitSummaryBlock =
    commit_summary_markdown?.trim() || "(새 커밋 없음)";

  const confirmedBlock = confirmedItems.length > 0
    ? ["", "### ✅ 확인 후 완료 처리", confirmedItems.map(t => `- [x] ${t}`).join("\n")].join("\n")
    : "";

  const pendingBlock = newPending.length > 0
    ? [
        "",
        "### ⚠️ 완료 후보 (확인 전, 미반영)",
        newPending.map(p => `- [ ] ${p.itemText}`).join("\n"),
      ].join("\n")
    : "";

  const report = [
    `## ${user_name} 스크럼 보고`,
    `_기간: ${periodLabel}_`,
    `_Git: ${pushedLog.branch} → ${pushedLog.upstream} (push 반영 기준)_`,
    "",
    `### 변경 요약 (${commits.length}커밋)`,
    commitSummaryBlock,
    confirmedBlock,
    pendingBlock,
    orphanCommitCount > 0
      ? `\n_체크리스트와 직접 연결되지 않은 변경 ${orphanCommitCount}건은 위 요약에 포함됨._`
      : "",
    pushedLog.unpushedCount > 0
      ? `\n_push되지 않은 로컬 커밋 ${pushedLog.unpushedCount}건은 이 보고에서 제외됨._`
      : "",
    "",
    "### 진행 상황",
    progressLine,
  ].join("\n");

  // Discord 포럼을 source-of-truth로 사용한다.
  // 오늘 생성된 회의 중 가장 최근 [진행] 스레드에만 이어서 게시한다.
  const client = new DiscordClient(token);
  const today = currentMeetingDate();
  const forum = await client.getChannel(forumId);
  const [inProgressTagId] = resolveForumTagIds(forum, [config.discord.tagInProgress]);
  const forumThreads = await client.listForumThreads(forumId);
  let existingThread = latestInProgressMeeting(
    forumThreads,
    inProgressTagId!,
    today,
  );

  let threadId: string;
  let isNewThread: boolean;
  let meetingNumber: number;
  let followupCount = 0;

  if (existingThread) {
    meetingNumber = meetingSequence(existingThread.name, today) ?? 1;
    const normalizedName = meetingThreadName(today, meetingNumber);
    if (existingThread.name !== normalizedName) {
      existingThread = await client.setThreadName(existingThread.id, normalizedName);
    }
    if (existingThread.thread_metadata?.archived || existingThread.archived) {
      existingThread = await client.setThreadArchived(existingThread.id, false);
    }
    threadId = existingThread.id;
    isNewThread = false;
    const msgIds = await client.postChunked(threadId, report);
    followupCount = msgIds.length;
  } else {
    meetingNumber = nextMeetingSequence(forumThreads, today);
    const { thread, followupMessageIds } = await client.createForumThread(
      forumId,
      meetingThreadName(today, meetingNumber),
      report,
      [inProgressTagId!],
    );
    threadId = thread.id;
    isNewThread = true;
    followupCount = followupMessageIds.length;
  }

  state.currentMeetingThreadId = threadId;
  state.lastReportedUpstreamHeads[pushedLog.upstream] =
    pushedLog.upstreamHead;
  state.pendingConfirmations = [];
  await saveState(state);

  return {
    content: [{
      type: "text" as const,
      text:
        `${isNewThread ? "포럼 회의 스레드 생성 완료" : "기존 회의 스레드에 보고 추가 완료"}\n` +
        `  포럼: ${forumId}\n` +
        `  스레드: ${meetingThreadName(today, meetingNumber)} (${threadId})\n` +
        `  ${isNewThread ? `태그: [${config.discord.tagInProgress}]\n  ` : ""}추가 메시지: ${followupCount}건\n` +
        `  확인 후 완료: ${confirmedItems.length > 0 ? confirmedItems.join(", ") : "없음"}\n` +
        `  미반영 완료 후보: ${newPending.length > 0 ? newPending.map(i => i.itemText).join(", ") : "없음"}\n` +
        `  체크리스트 미연결 변경: ${orphanCommitCount}건\n\n` +
        `  push되지 않아 제외된 로컬 커밋: ${pushedLog.unpushedCount}건\n\n` +
        `이제 스크럼은 위 스레드의 댓글로 진행하세요. 회의가 끝나면 finish_meeting을 호출하면 됩니다.`,
    }],
  };
}
