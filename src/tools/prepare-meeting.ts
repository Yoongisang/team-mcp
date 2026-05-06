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
    "커밋과 체크리스트 항목이 부분적으로 일치하면 Discord 포스트 전에 " +
    "사용자에게 확인을 요청한다. confirmed_indexes를 포함해 재호출하면 " +
    "확인 결과를 체크리스트에 반영하고 Discord에 포스트한다.",
  inputSchema: {
    type: "object",
    properties: {
      user_name: {
        type: "string",
        description:
          "스크럼 보고자 이름 (git --author 매칭에 사용). " +
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
    },
    required: ["user_name"],
    additionalProperties: false,
  },
};

const Args = z.object({
  user_name: z.string().min(1),
  confirmed_indexes: z.array(z.number()).optional(),
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
  const { user_name, confirmed_indexes } = Args.parse(raw);
  const token = requireConfig(config.discord.botToken, "DISCORD_BOT_TOKEN");
  const forumId = requireConfig(
    config.discord.scrumChannelId,
    "DISCORD_SCRUM_CHANNEL_ID",
  );

  const state = await loadState();
  const since = state.lastPrepareMeetingAt;

  // ── git 커밋 수집 ────────────────────────────────────────────────────
  const baseCommits = await gitLog({ author: user_name, since, limit: 50 });
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
  if (confirmed_indexes !== undefined) {
    const pending = state.pendingConfirmations ?? [];
    if (pending.length > 0 && confirmed_indexes.length > 0) {
      const raw_ckl = await readGameFile(GAME_FILES.checklist);
      const { items, lines } = parseChecklist(raw_ckl);
      let updatedLines = lines;
      for (const p of pending) {
        if (!confirmed_indexes.includes(p.index)) continue;
        const target = items.find(i => !i.done && i.text === p.itemText);
        if (target) updatedLines = setItemDone(updatedLines, target, true);
      }
      await writeGameFile(GAME_FILES.checklist, joinLines(updatedLines), { overwrite: true });
    }
    state.pendingConfirmations = [];
    await saveState(state);
  }

  // ── 체크리스트 자동완료 (고신뢰) + 부분 매칭 탐지 ───────────────────
  const { completed: autoCompleted, pending: newPending } = await autoCompleteFromCommits(commits);

  // ── 1차 호출이고 부분 매칭 항목이 있으면 → Discord 포스트 전에 질문 반환
  if (confirmed_indexes === undefined && newPending.length > 0) {
    state.pendingConfirmations = newPending;
    await saveState(state);

    const lines = [
      "다음 항목들이 이번 커밋으로 완료된 작업과 같은가요?\n",
      ...newPending.map(p =>
        `**${p.index}.** ${p.itemText}\n   ← \`${p.commitSubject}\``
      ),
      "\n완료된 항목 번호를 `confirmed_indexes`에 담아 다시 호출해주세요.",
      "없으면 빈 배열 `[]`로 호출하면 Discord 포스트로 진행합니다.",
    ];

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  }

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
  const periodLabel = since
    ? `${since.slice(0, 19).replace("T", " ")} ~ 지금`
    : "최근 7일";

  const commitsBlock = commits.length === 0
    ? "(없음)"
    : commits.map((c) => {
        const ls: string[] = [`- \`${c.hash.slice(0, 7)}\` ${c.subject}`];
        if (c.filesChanged !== undefined && c.filesChanged > 0) {
          ls.push(`  - 변경: ${c.filesChanged} files, +${c.insertions ?? 0}/-${c.deletions ?? 0}`);
        }
        if (c.topFiles && c.topFiles.length > 0) {
          const more = (c.filesChanged ?? 0) > c.topFiles.length
            ? ` 외 ${(c.filesChanged ?? 0) - c.topFiles.length}개` : "";
          ls.push(`  - 파일: ${c.topFiles.join(", ")}${more}`);
        }
        if (c.body) {
          const bodyLines = c.body.split("\n").map(s => s.trim()).filter(Boolean).slice(0, 3);
          for (const bl of bodyLines) ls.push(`  - ${bl.length > 120 ? bl.slice(0, 117) + "..." : bl}`);
        }
        return ls.join("\n");
      }).join("\n");

  const autoCompleteBlock = autoCompleted.length > 0
    ? ["", "### ✅ 자동 완료 처리", autoCompleted.map(i => `- [x] ${i.text}`).join("\n")].join("\n")
    : "";

  const report = [
    `## ${user_name} 스크럼 보고`,
    `_기간: ${periodLabel}_`,
    "",
    "### 최근 커밋",
    commitsBlock,
    autoCompleteBlock,
    "",
    "### 진행 상황",
    progressLine,
  ].join("\n");

  // ── Discord 포스트 (스레드 재사용 or 신규 생성) ───────────────────────
  const client = new DiscordClient(token);
  const today = new Date().toISOString().slice(0, 10);
  let threadId: string;
  let isNewThread: boolean;
  let followupCount = 0;

  if (state.currentMeetingThreadId) {
    threadId = state.currentMeetingThreadId;
    isNewThread = false;
    const msgIds = await client.postChunked(threadId, report);
    followupCount = msgIds.length;
  } else {
    const forum = await client.getChannel(forumId);
    const [inProgressTagId] = resolveForumTagIds(forum, [config.discord.tagInProgress]);
    const { thread, followupMessageIds } = await client.createForumThread(
      forumId, `스크럼 회의 ${today}`, report, [inProgressTagId!],
    );
    threadId = thread.id;
    isNewThread = true;
    followupCount = followupMessageIds.length;
  }

  state.currentMeetingThreadId = threadId;
  state.pendingConfirmations = [];
  await saveState(state);

  return {
    content: [{
      type: "text" as const,
      text:
        `${isNewThread ? "포럼 회의 스레드 생성 완료" : "기존 회의 스레드에 보고 추가 완료"}\n` +
        `  포럼: ${forumId}\n` +
        `  스레드: ${threadId}\n` +
        `  ${isNewThread ? `태그: [${config.discord.tagInProgress}]\n  ` : ""}추가 메시지: ${followupCount}건\n` +
        `  자동완료: ${autoCompleted.length > 0 ? autoCompleted.map(i => i.text).join(", ") : "없음"}\n\n` +
        `이제 스크럼은 위 스레드의 댓글로 진행하세요. 회의가 끝나면 finish_meeting을 호출하면 됩니다.`,
    }],
  };
}
