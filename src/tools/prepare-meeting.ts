import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { config, requireConfig } from "../config.js";
import { DiscordClient, resolveForumTagIds } from "../lib/discord.js";
import { GAME_FILES, gameFileExists, readGameFile, writeGameFile } from "../lib/files.js";
import { gitLog, gitShowDetails } from "../lib/git.js";
import {
  parseChecklist,
  progress,
  setItemDone,
  joinLines,
  type ChecklistItem,
} from "../lib/markdown.js";
import { loadState, saveState, type PendingConfirmation } from "../lib/state.js";
import type { Commit } from "../lib/git.js";

export const prepareMeetingTool: Tool = {
  name: "prepare_meeting",
  description:
    "마지막 prepare_meeting 이후의 git 커밋과 체크리스트 진행률을 모아 " +
    "Discord 포럼 채널에 [진행] 태그로 새 회의 스레드를 생성한다. " +
    "이후 스크럼은 이 스레드의 댓글로 진행되며, finish_meeting 호출 시 " +
    "댓글들을 수집해 Notion·Jira에 정리한다. 전송 후 타임스탬프와 " +
    "thread ID를 state에 저장해 다음 호출 시 중복 보고를 방지한다.",
  inputSchema: {
    type: "object",
    properties: {
      user_name: {
        type: "string",
        description:
          "스크럼 보고자 이름 (git --author 매칭에 사용). " +
          "Discord 메시지로 트리거된 경우 메시지 작성자의 표시 이름을 그대로 전달.",
      },
    },
    required: ["user_name"],
    additionalProperties: false,
  },
};

const Args = z.object({ user_name: z.string().min(1) });

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
  completed: ChecklistItem[];
  pending: PendingConfirmation[];
}

/**
 * 커밋 목록을 체크리스트 항목과 매칭해 자동완료 처리.
 * - 고신뢰 매칭 → 즉시 [x] 처리
 * - 부분 매칭 → 사용자 확인 대기 목록에 추가
 */
async function autoCompleteFromCommits(
  commits: Commit[],
): Promise<AutoCompleteResult> {
  if (commits.length === 0) return { completed: [], pending: [] };
  if (!(await gameFileExists(GAME_FILES.checklist))) return { completed: [], pending: [] };

  const raw = await readGameFile(GAME_FILES.checklist);
  const { items, lines } = parseChecklist(raw);
  const incomplete = items.filter(i => !i.done);
  if (incomplete.length === 0) return { completed: [], pending: [] };

  const completed: ChecklistItem[] = [];
  const pending: PendingConfirmation[] = [];
  let updatedLines = lines;
  let pendingIndex = 1;

  for (const item of incomplete) {
    let bestConfidence: MatchConfidence = "none";
    let bestCommit: Commit | undefined;

    for (const c of commits) {
      const conf = commitMatchConfidence(item.text, c);
      if (conf === "high") { bestConfidence = "high"; bestCommit = c; break; }
      if (conf === "partial" && bestConfidence === "none") {
        bestConfidence = "partial";
        bestCommit = c;
      }
    }

    if (bestConfidence === "high") {
      completed.push(item);
      updatedLines = setItemDone(updatedLines, item, true);
    } else if (bestConfidence === "partial" && bestCommit) {
      pending.push({
        index: pendingIndex++,
        itemText: item.text,
        commitSubject: bestCommit.subject,
      });
    }
  }

  if (completed.length > 0) {
    await writeGameFile(GAME_FILES.checklist, joinLines(updatedLines), { overwrite: true });
  }

  return { completed, pending };
}

export async function prepareMeeting(raw: unknown) {
  const { user_name } = Args.parse(raw);
  const token = requireConfig(config.discord.botToken, "DISCORD_BOT_TOKEN");
  const forumId = requireConfig(
    config.discord.scrumChannelId,
    "DISCORD_SCRUM_CHANNEL_ID",
  );

  const state = await loadState();
  const since = state.lastPrepareMeetingAt;

  const baseCommits = await gitLog({ author: user_name, since, limit: 50 });
  // 상세 정보는 최대 10개만 (스레드 길이 제한 고려)
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

  // 커밋 기반 체크리스트 자동완료
  const { completed: autoCompleted, pending: pendingConfirmations } = await autoCompleteFromCommits(commits);

  let progressLine = "(체크리스트 없음)";
  if (await gameFileExists(GAME_FILES.checklist)) {
    // 자동완료 후 최신 상태로 다시 읽기
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

  // 자동완료 블록
  const autoCompleteBlock = autoCompleted.length > 0
    ? [
        "",
        "### ✅ 자동 완료 처리",
        autoCompleted.map(i => `- [x] ${i.text}`).join("\n"),
      ].join("\n")
    : "";

  // 확인 요청 블록
  const confirmBlock = pendingConfirmations.length > 0
    ? [
        "",
        "### ❓ 확인 필요",
        "아래 항목이 이번 커밋으로 완료됐나요? 맞으면 댓글에 번호를 입력해주세요 (예: `1 2`).",
        pendingConfirmations
          .map(p => `${p.index}. **${p.itemText}** ← \`${p.commitSubject}\``)
          .join("\n"),
      ].join("\n")
    : "";

  const periodLabel = since
    ? `${since.slice(0, 19).replace("T", " ")} ~ 지금`
    : "최근 7일";

  const commitsBlock = commits.length === 0
    ? "(없음)"
    : commits
        .map((c) => {
          const lines: string[] = [`- \`${c.hash.slice(0, 7)}\` ${c.subject}`];
          if (c.filesChanged !== undefined && c.filesChanged > 0) {
            const stat = `${c.filesChanged} files, +${c.insertions ?? 0}/-${c.deletions ?? 0}`;
            lines.push(`  - 변경: ${stat}`);
          }
          if (c.topFiles && c.topFiles.length > 0) {
            const more = (c.filesChanged ?? 0) > c.topFiles.length
              ? ` 외 ${(c.filesChanged ?? 0) - c.topFiles.length}개`
              : "";
            lines.push(`  - 파일: ${c.topFiles.join(", ")}${more}`);
          }
          if (c.body) {
            // body 첫 3줄만 (너무 길면 자름)
            const bodyLines = c.body.split("\n").map(s => s.trim()).filter(Boolean).slice(0, 3);
            for (const bl of bodyLines) {
              lines.push(`  - ${bl.length > 120 ? bl.slice(0, 117) + "..." : bl}`);
            }
          }
          return lines.join("\n");
        })
        .join("\n");

  const report = [
    `## ${user_name} 스크럼 보고`,
    `_기간: ${periodLabel}_`,
    "",
    "### 최근 커밋",
    commitsBlock,
    autoCompleteBlock,
    confirmBlock,
    "",
    "### 진행 상황",
    progressLine,
  ].join("\n");

  const client = new DiscordClient(token);
  const today = new Date().toISOString().slice(0, 10);

  // ── 스레드 재사용 vs 신규 생성 ────────────────────────────────────────
  // currentMeetingThreadId가 있으면 기존 스레드에 추가 포스트 (다중 사용자 지원)
  let threadId: string;
  let isNewThread: boolean;
  let followupCount = 0;

  if (state.currentMeetingThreadId) {
    // 기존 회의 스레드에 개인 보고를 추가 메시지로 포스트
    threadId = state.currentMeetingThreadId;
    isNewThread = false;
    const msgIds = await client.postChunked(threadId, report);
    followupCount = msgIds.length;
  } else {
    // 오늘의 첫 prepare_meeting → 새 스레드 생성
    const forum = await client.getChannel(forumId);
    const [inProgressTagId] = resolveForumTagIds(forum, [
      config.discord.tagInProgress,
    ]);
    const threadName = `스크럼 회의 ${today}`;
    const { thread, followupMessageIds } = await client.createForumThread(
      forumId,
      threadName,
      report,
      [inProgressTagId!],
    );
    threadId = thread.id;
    isNewThread = true;
    followupCount = followupMessageIds.length;
  }

  // lastPrepareMeetingAt은 finish_meeting에서만 갱신 (다중 사용자 타임스탬프 오염 방지)
  state.currentMeetingThreadId = threadId;
  state.pendingConfirmations = pendingConfirmations;
  await saveState(state);

  return {
    content: [
      {
        type: "text" as const,
        text:
          `${isNewThread ? "포럼 회의 스레드 생성 완료" : "기존 회의 스레드에 보고 추가 완료"}\n` +
          `  포럼: ${forumId}\n` +
          `  스레드: ${threadId}\n` +
          `  ${isNewThread ? `태그: [${config.discord.tagInProgress}]\n  ` : ""}추가 메시지: ${followupCount}건\n` +
          `  자동완료 항목: ${autoCompleted.length > 0 ? autoCompleted.map(i => i.text).join(", ") : "없음"}\n` +
          `  확인 대기 항목: ${pendingConfirmations.length > 0 ? pendingConfirmations.map(p => `${p.index}. ${p.itemText}`).join(", ") : "없음"}\n\n` +
          `이제 스크럼은 위 스레드의 댓글로 진행하세요. ` +
          `회의가 끝나면 finish_meeting을 호출하면 됩니다.`,
      },
    ],
  };
}
