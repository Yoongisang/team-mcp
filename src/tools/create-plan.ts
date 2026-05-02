import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  GAME_FILES,
  gameFileExists,
  readGameFile,
  writeGameFile,
} from "../lib/files.js";

export const createPlanTool: Tool = {
  name: "create_plan",
  description:
    "기획서.md와 내파트.md를 바탕으로 플랜.md, 체크리스트.md를 생성한다. " +
    "인자 없이 호출하면 두 입력 파일의 내용을 반환한다(컨텍스트 수집 모드). " +
    "분석 후 plan_markdown, checklist_markdown 인자로 다시 호출하면 파일을 작성한다.",
  inputSchema: {
    type: "object",
    properties: {
      plan_markdown: {
        type: "string",
        description: "작성할 플랜.md 전체 내용",
      },
      checklist_markdown: {
        type: "string",
        description: "작성할 체크리스트.md 전체 내용 (`- [ ] 항목` 형식)",
      },
      force: {
        type: "boolean",
        description: "기존 파일이 있어도 덮어쓴다",
        default: false,
      },
    },
    additionalProperties: false,
  },
};

const Args = z.object({
  plan_markdown: z.string().optional(),
  checklist_markdown: z.string().optional(),
  force: z.boolean().optional(),
});

export async function createPlan(raw: unknown) {
  const args = Args.parse(raw);

  if (!args.plan_markdown && !args.checklist_markdown) {
    const spec = await readGameFile(GAME_FILES.spec).catch(
      () => `(${GAME_FILES.spec} 없음)`,
    );
    const myPart = await readGameFile(GAME_FILES.myPart).catch(
      () => `(${GAME_FILES.myPart} 없음)`,
    );
    const text = [
      "# 컨텍스트 수집 모드",
      "",
      `## ${GAME_FILES.spec}`,
      spec,
      "",
      `## ${GAME_FILES.myPart}`,
      myPart,
      "",
      "---",
      "위 내용을 분석해 다음을 작성한 뒤 create_plan을 다시 호출하세요:",
      "  - plan_markdown: 플랜.md 전체 내용 (목표·마일스톤·기술 결정 등)",
      "  - checklist_markdown: 체크리스트.md 전체 내용 (`- [ ] 항목` 형식, 그룹은 `## 그룹명`으로)",
    ].join("\n");
    return { content: [{ type: "text" as const, text }] };
  }

  if (!args.plan_markdown || !args.checklist_markdown) {
    throw new Error(
      "plan_markdown과 checklist_markdown을 모두 전달해야 한다 (둘 다 있거나 둘 다 없거나).",
    );
  }

  const planExists = await gameFileExists(GAME_FILES.plan);
  const checklistExists = await gameFileExists(GAME_FILES.checklist);
  if ((planExists || checklistExists) && !args.force) {
    const which = [planExists && GAME_FILES.plan, checklistExists && GAME_FILES.checklist]
      .filter(Boolean)
      .join(", ");
    throw new Error(
      `이미 존재: ${which}. 덮어쓰려면 force=true 로 호출하라.`,
    );
  }

  await writeGameFile(GAME_FILES.plan, args.plan_markdown, { overwrite: true });
  await writeGameFile(GAME_FILES.checklist, args.checklist_markdown, {
    overwrite: true,
  });

  return {
    content: [
      {
        type: "text" as const,
        text: `작성 완료:\n  - ${GAME_FILES.plan}\n  - ${GAME_FILES.checklist}`,
      },
    ],
  };
}
