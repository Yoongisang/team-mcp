import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { config, requireConfig } from "../config.js";
import { DiscordClient, resolveForumTagIds, type DiscordThread } from "../lib/discord.js";
import { GAME_FILES, gameFileExists, readGameFile, writeGameFile } from "../lib/files.js";
import { gitLog, gitShowDetails } from "../lib/git.js";
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

  const orphanSubjects = orphanCommits.map((c) => c.subject);

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

  const confirmedBlock = confirmedItems.length > 0
    ? ["", "### ✅ 확인 후 완료 처리", confirmedItems.map(t => `- [x] ${t}`).join("\n")].join("\n")
    : "";

  const pendingBlock = newPending.length > 0
    ? [
        "",
        "### ⚠️ 완료 후보 (확인 전, 미반영)",
        newPending.map(p => `- [ ] ${p.itemText} ← ${p.commitSubject}`).join("\n"),
      ].join("\n")
    : "";

  const orphanBlock = orphanSubjects.length > 0
    ? [
        "",
        "### ➕ 체크리스트에 없는 커밋 후보 (자동 추가 안 함)",
        orphanSubjects.map(t => `- ${t}`).join("\n"),
      ].join("\n")
    : "";

  const report = [
    `## ${user_name} 스크럼 보고`,
    `_기간: ${periodLabel}_`,
    "",
    "### 최근 커밋",
    commitsBlock,
    confirmedBlock,
    pendingBlock,
    orphanBlock,
    "",
    "### 진행 상황",
    progressLine,
  ].join("\n");

  // ── Discord 포스트 (활성 [진행] 스레드 재사용 or 신규 생성) ───────────
  //
  // 우선순위:
  //   1) Discord 포럼의 활성 [진행] 스레드 자동 탐색 (팀원 누가 만든 것이든)
  //   2) 검색 실패 시: 로컬 state.currentMeetingThreadId 폴백
  //   3) 둘 다 없으면: 신규 스레드 생성
  //
  // 변경 의도:
  //   기존엔 state.currentMeetingThreadId만 봐서, 팀원마다 로컬 state가
  //   분리된 환경에서는 각자 별도 스레드를 생성하는 문제가 있었음.
  //   Discord 포럼을 source-of-truth로 삼아 같은 [진행] 스레드에 수렴.
  const client = new DiscordClient(token);
  const today = new Date().toISOString().slice(0, 10);
  const forum = await client.getChannel(forumId);
  const [inProgressTagId] = resolveForumTagIds(forum, [config.discord.tagInProgress]);

  let threadId: string;
  let isNewThread: boolean;
  let followupCount = 0;

  // 1) 포럼에서 활성 [진행] 스레드 탐색 (실패해도 다음 단계로 넘어감)
  let existingThread: DiscordThread | undefined;
  try {
    const activeThreads = await client.listActiveForumThreads(forumId);
    existingThread = activeThreads
      .filter((t) => t.applied_tags?.includes(inProgressTagId!))
      .sort((a, b) => b.id.localeCompare(a.id))[0]; // snowflake 내림차순 = 가장 최근
  } catch (err) {
    // 활성 스레드 조회 실패는 치명적 아님 — 폴백 경로로 계속
    console.error("[prepare_meeting] listActiveForumThreads failed:", err);
  }

  if (existingThread) {
    // 1) 활성 [진행] 스레드 발견 → 본인 보고를 댓글로 추가
    threadId = existingThread.id;
    isNewThread = false;
    const msgIds = await client.postChunked(threadId, report);
    followupCount = msgIds.length;
  } else if (state.currentMeetingThreadId) {
    // 2) Discord 검색 실패 시 로컬 state 폴백
    threadId = state.currentMeetingThreadId;
    isNewThread = false;
    const msgIds = await client.postChunked(threadId, report);
    followupCount = msgIds.length;
  } else {
    // 3) 활성 스레드 없음 → 새로 생성
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
        `  확인 후 완료: ${confirmedItems.length > 0 ? confirmedItems.join(", ") : "없음"}\n` +
        `  미반영 완료 후보: ${newPending.length > 0 ? newPending.map(i => i.itemText).join(", ") : "없음"}\n` +
        `  체크리스트 없는 커밋 후보: ${orphanSubjects.length > 0 ? orphanSubjects.join(", ") : "없음"}\n\n` +
        `이제 스크럼은 위 스레드의 댓글로 진행하세요. 회의가 끝나면 finish_meeting을 호출하면 됩니다.`,
    }],
  };
}
