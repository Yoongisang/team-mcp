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
    "【최초 세팅 모드】spec_content + my_part_content를 전달하면 두 파일을 먼저 게임 레포에 저장한 뒤 " +
    "컨텍스트 수집 단계로 진입한다 — 파일이 없어도 처음부터 플랜을 만들 수 있다. " +
    "【컨텍스트 수집 모드】인자 없이 호출하면 기존 기획서.md·내파트.md 내용을 반환한다. " +
    "【작성 모드】plan_markdown + checklist_markdown 인자로 다시 호출하면 파일을 작성한다.",
  inputSchema: {
    type: "object",
    properties: {
      spec_content: {
        type: "string",
        description:
          "기획서 내용을 직접 전달 (최초 세팅 시 사용). " +
          "게임 레포의 기획서.md가 없을 때 이 값으로 파일을 먼저 생성한다.",
      },
      my_part_content: {
        type: "string",
        description:
          "내 파트 내용을 직접 전달 (최초 세팅 시 사용). " +
          "게임 레포의 내파트.md가 없을 때 이 값으로 파일을 먼저 생성한다.",
      },
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
  spec_content: z.string().optional(),
  my_part_content: z.string().optional(),
  plan_markdown: z.string().optional(),
  checklist_markdown: z.string().optional(),
  force: z.boolean().optional(),
});

export async function createPlan(raw: unknown) {
  const args = Args.parse(raw);

  // 최초 세팅 모드: 인라인 내용이 전달된 경우 파일 먼저 저장
  if (args.spec_content || args.my_part_content) {
    const specExists = await gameFileExists(GAME_FILES.spec);
    const partExists = await gameFileExists(GAME_FILES.myPart);

    if (args.spec_content && (!specExists || args.force)) {
      await writeGameFile(GAME_FILES.spec, args.spec_content, { overwrite: true });
    }
    if (args.my_part_content && (!partExists || args.force)) {
      await writeGameFile(GAME_FILES.myPart, args.my_part_content, { overwrite: true });
    }
  }

  // 작성 모드: plan + checklist 둘 다 전달된 경우 파일 작성
  if (args.plan_markdown && args.checklist_markdown) {
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
    await writeGameFile(GAME_FILES.checklist, args.checklist_markdown, { overwrite: true });
    return {
      content: [
        {
          type: "text" as const,
          text: `작성 완료:\n  - ${GAME_FILES.plan}\n  - ${GAME_FILES.checklist}`,
        },
      ],
    };
  }

  // plan/checklist 중 하나만 전달된 경우 에러
  if (args.plan_markdown || args.checklist_markdown) {
    throw new Error(
      "plan_markdown과 checklist_markdown을 모두 전달해야 한다 (둘 다 있거나 둘 다 없거나).",
    );
  }

  // 컨텍스트 수집 모드: 기획서 + 내파트 읽어서 반환
  const spec = await readGameFile(GAME_FILES.spec).catch(
    () => `(${GAME_FILES.spec} 없음 — create_plan에 spec_content를 전달해 생성 가능)`,
  );
  const myPart = await readGameFile(GAME_FILES.myPart).catch(
    () => `(${GAME_FILES.myPart} 없음 — create_plan에 my_part_content를 전달해 생성 가능)`,
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
