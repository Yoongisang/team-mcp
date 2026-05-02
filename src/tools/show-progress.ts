import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { GAME_FILES, gameFileExists, readGameFile } from "../lib/files.js";
import { parseChecklist, progress } from "../lib/markdown.js";
import { estimateCompletionDate, loadState } from "../lib/state.js";

export const showProgressTool: Tool = {
  name: "show_progress",
  description: "체크리스트.md 진행률·미완료 항목·예상 완료일을 보여준다.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
};

const MAX_INCOMPLETE_LIST = 10;

export async function showProgress() {
  if (!(await gameFileExists(GAME_FILES.checklist))) {
    return {
      content: [
        {
          type: "text" as const,
          text: `${GAME_FILES.checklist} 없음. create_plan 먼저 호출 필요.`,
        },
      ],
      isError: true,
    };
  }

  const content = await readGameFile(GAME_FILES.checklist);
  const { items } = parseChecklist(content);
  const { done, total, ratio } = progress(items);

  if (total === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: "체크리스트에 항목이 없음. (`- [ ] 항목` 형식 필요)",
        },
      ],
    };
  }

  const pct = (ratio * 100).toFixed(1);
  const incomplete = items.filter((i) => !i.done);
  const state = await loadState();
  const eta = estimateCompletionDate(state, incomplete.length);

  let text = `진행률: ${done}/${total} (${pct}%)`;
  if (eta) {
    text += `\n예상 완료일: ${eta} (완료 ${state.completions.length}건 기반)`;
  } else if (state.completions.length < 2) {
    text += `\n예상 완료일: 데이터 부족 (완료 ${state.completions.length}건, 2건 이상 필요)`;
  }

  if (incomplete.length === 0) {
    text += "\n\n전체 완료.";
  } else {
    const shown = incomplete.slice(0, MAX_INCOMPLETE_LIST);
    const more = incomplete.length - shown.length;
    text += "\n\n미완료 항목:";
    for (const i of shown) text += `\n  - ${i.text}`;
    if (more > 0) text += `\n  ... 외 ${more}개`;
  }

  return {
    content: [{ type: "text" as const, text }],
  };
}
