import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { GAME_FILES, readGameFile } from "../lib/files.js";

export const changeDirectionTool: Tool = {
  name: "change_direction",
  description:
    "방향 변경 설명을 받아 현재 플랜과 체크리스트 컨텍스트를 반환한다. " +
    "파일은 변경하지 않는다. 호출 AI가 영향 항목을 식별하고 수정안을 제시한 뒤, " +
    "update_plan 또는 complete_task로 적용해야 한다.",
  inputSchema: {
    type: "object",
    properties: {
      change_description: {
        type: "string",
        description: "방향 변경 내용 (예: 'AI를 BT에서 GOAP으로 전환')",
      },
    },
    required: ["change_description"],
    additionalProperties: false,
  },
};

const Args = z.object({ change_description: z.string().min(1) });

export async function changeDirection(raw: unknown) {
  const { change_description } = Args.parse(raw);

  const plan = await readGameFile(GAME_FILES.plan).catch(
    () => `(${GAME_FILES.plan} 없음)`,
  );
  const checklist = await readGameFile(GAME_FILES.checklist).catch(
    () => `(${GAME_FILES.checklist} 없음)`,
  );

  const text = [
    "# 방향 변경 분석 요청",
    "",
    "## 변경 내용",
    change_description,
    "",
    `## 현재 ${GAME_FILES.plan}`,
    plan,
    "",
    `## 현재 ${GAME_FILES.checklist}`,
    checklist,
    "",
    "---",
    "위 내용을 검토해 다음을 정리한 뒤 적용하라:",
    "  1. 변경의 영향을 받는 체크리스트 항목 (제거·신규·재배치)",
    "  2. 플랜.md에 반영할 결정·이유",
    "  3. 적용 방법: update_plan(플랜/체크리스트 갱신), complete_task(폐기 항목은 직접 처리하지 말 것 — 체크리스트에서 제거가 맞음)",
  ].join("\n");

  return { content: [{ type: "text" as const, text }] };
}
