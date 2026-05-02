import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { config, requireConfig } from "../config.js";
import { DiscordClient } from "../lib/discord.js";
import { GAME_FILES, gameFileExists, readGameFile } from "../lib/files.js";
import { gitLog } from "../lib/git.js";
import { parseChecklist, progress } from "../lib/markdown.js";
import { loadState, saveState } from "../lib/state.js";

export const prepareMeetingTool: Tool = {
  name: "prepare_meeting",
  description:
    "마지막 prepare_meeting 이후의 git 커밋과 체크리스트 진행률을 종합해 Discord 스크럼 채널로 전송한다. 전송 후 타임스탬프를 갱신해 다음 호출 시 중복 보고를 방지한다.",
  inputSchema: {
    type: "object",
    properties: {
      user_name: {
        type: "string",
        description: "스크럼 보고자 이름 (git --author 매칭에 사용)",
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
  const channelId = requireConfig(
    config.discord.scrumChannelId,
    "DISCORD_SCRUM_CHANNEL_ID",
  );

  const state = await loadState();
  const since = state.lastPrepareMeetingAt;

  const commits = await gitLog({ author: user_name, since, limit: 50 });

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
        .map((c) => `- \`${c.hash.slice(0, 7)}\` ${c.subject}`)
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
  const messageIds = await client.postChunked(channelId, report);

  const now = new Date().toISOString();
  state.lastPrepareMeetingAt = now;
  await saveState(state);

  return {
    content: [
      {
        type: "text" as const,
        text:
          `Discord 전송 완료\n` +
          `  채널: ${channelId}\n` +
          `  메시지 수: ${messageIds.length}\n` +
          `  메시지 ID: ${messageIds.join(", ")}\n` +
          `  타임스탬프 갱신: ${now}`,
      },
    ],
  };
}
