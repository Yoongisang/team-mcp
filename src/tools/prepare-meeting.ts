import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { config, requireConfig } from "../config.js";
import { DiscordClient, resolveForumTagIds } from "../lib/discord.js";
import { GAME_FILES, gameFileExists, readGameFile } from "../lib/files.js";
import { gitLog, gitShowDetails } from "../lib/git.js";
import { parseChecklist, progress } from "../lib/markdown.js";
import { loadState, saveState } from "../lib/state.js";

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
    "",
    "### 진행 상황",
    progressLine,
  ].join("\n");

  const client = new DiscordClient(token);
  const forum = await client.getChannel(forumId);
  const [inProgressTagId] = resolveForumTagIds(forum, [
    config.discord.tagInProgress,
  ]);

  const today = new Date().toISOString().slice(0, 10);
  const threadName = `스크럼 회의 ${today}`;

  const { thread, followupMessageIds } = await client.createForumThread(
    forumId,
    threadName,
    report,
    [inProgressTagId!],
  );

  const now = new Date().toISOString();
  state.lastPrepareMeetingAt = now;
  state.currentMeetingThreadId = thread.id;
  await saveState(state);

  return {
    content: [
      {
        type: "text" as const,
        text:
          `포럼 회의 스레드 생성 완료\n` +
          `  포럼: ${forumId}\n` +
          `  스레드: ${thread.id} (${thread.name})\n` +
          `  태그: [${config.discord.tagInProgress}]\n` +
          `  추가 메시지: ${followupMessageIds.length}건\n` +
          `  타임스탬프 갱신: ${now}\n\n` +
          `이제 스크럼은 위 스레드의 댓글로 진행하세요. ` +
          `회의가 끝나면 finish_meeting을 호출하면 됩니다.`,
      },
    ],
  };
}
