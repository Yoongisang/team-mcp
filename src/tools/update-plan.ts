import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { GAME_FILES, writeGameFile } from "../lib/files.js";

export const updatePlanTool: Tool = {
  name: "update_plan",
  description:
    "플랜.md, 체크리스트.md 중 하나 또는 둘 다 직접 갱신한다. 받은 내용으로 전체 덮어쓴다. " +
    "방향 변경이 아닌 일반 수정용. (방향 변경 영향 분석은 change_direction 먼저)",
  inputSchema: {
    type: "object",
    properties: {
      plan_markdown: {
        type: "string",
        description: "갱신할 플랜.md 전체 내용 (전달 시 덮어씀)",
      },
      checklist_markdown: {
        type: "string",
        description: "갱신할 체크리스트.md 전체 내용 (전달 시 덮어씀)",
      },
    },
    additionalProperties: false,
  },
};

const Args = z.object({
  plan_markdown: z.string().optional(),
  checklist_markdown: z.string().optional(),
});

export async function updatePlan(raw: unknown) {
  const args = Args.parse(raw);
  if (!args.plan_markdown && !args.checklist_markdown) {
    throw new Error(
      "plan_markdown 또는 checklist_markdown 중 최소 하나는 전달해야 한다.",
    );
  }

  const updated: string[] = [];
  if (args.plan_markdown !== undefined) {
    await writeGameFile(GAME_FILES.plan, args.plan_markdown, { overwrite: true });
    updated.push(GAME_FILES.plan);
  }
  if (args.checklist_markdown !== undefined) {
    await writeGameFile(GAME_FILES.checklist, args.checklist_markdown, {
      overwrite: true,
    });
    updated.push(GAME_FILES.checklist);
  }

  return {
    content: [
      {
        type: "text" as const,
        text: `갱신 완료:\n${updated.map((f) => `  - ${f}`).join("\n")}`,
      },
    ],
  };
}
