import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { GAME_FILES, readGameFile } from "../lib/files.js";

export const getTeamRulesTool: Tool = {
  name: "get_team_rules",
  description: "팀 공통 규칙(AGENTS.md) 내용을 그대로 반환한다.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
};

export async function getTeamRules() {
  const content = await readGameFile(GAME_FILES.agents);
  return {
    content: [{ type: "text" as const, text: content }],
  };
}
