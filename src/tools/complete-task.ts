import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { GAME_FILES, readGameFile, writeGameFile } from "../lib/files.js";
import { joinLines, parseChecklist, setItemDone } from "../lib/markdown.js";
import { loadState, saveState } from "../lib/state.js";

export const completeTaskTool: Tool = {
  name: "complete_task",
  description:
    "체크리스트에서 task_name이 (대소문자 무시 부분 일치) 매칭되는 미완료 항목을 [x]로 변경하고, 다음 미완료 항목을 추천한다.",
  inputSchema: {
    type: "object",
    properties: {
      task_name: {
        type: "string",
        description: "완료 처리할 항목명 (부분 일치)",
      },
    },
    required: ["task_name"],
    additionalProperties: false,
  },
};

const Args = z.object({ task_name: z.string().min(1) });

export async function completeTask(raw: unknown) {
  const { task_name } = Args.parse(raw);
  const content = await readGameFile(GAME_FILES.checklist);
  const { items, lines } = parseChecklist(content);

  const needle = task_name.toLowerCase();
  const incomplete = items.filter((i) => !i.done);
  const matches = incomplete.filter((i) => i.text.toLowerCase().includes(needle));

  if (matches.length === 0) {
    throw new Error(
      `매칭되는 미완료 항목 없음: "${task_name}" (이미 완료되었거나 항목명이 다를 수 있음)`,
    );
  }

  if (matches.length > 1) {
    return {
      content: [
        {
          type: "text" as const,
          text:
            `"${task_name}"에 매칭되는 미완료 항목이 ${matches.length}개입니다. 체크리스트는 변경하지 않았습니다.\n` +
            "더 구체적인 항목명으로 다시 호출하세요.\n\n" +
            matches.map((m) => `  - ${m.text}`).join("\n"),
        },
      ],
      isError: true,
    };
  }

  const target = matches[0]!;
  const updatedLines = setItemDone(lines, target, true);
  await writeGameFile(GAME_FILES.checklist, joinLines(updatedLines), {
    overwrite: true,
  });

  const state = await loadState();
  state.completions.push({
    task: target.text,
    completedAt: new Date().toISOString(),
  });
  await saveState(state);

  const nextItems = incomplete.filter((i) => i.lineIndex !== target.lineIndex);
  const nextSuggestion = nextItems[0]?.text ?? "(전체 완료)";

  return {
    content: [
      {
        type: "text" as const,
        text:
          `완료 처리: ${target.text}\n다음 작업 추천: ${nextSuggestion}`,
      },
    ],
  };
}
