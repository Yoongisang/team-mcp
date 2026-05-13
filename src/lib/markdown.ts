export interface ChecklistItem {
  done: boolean;
  text: string;
  indent: number;
  lineIndex: number;
}

const ITEM_RE = /^(\s*)-\s+\[([ xX])\]\s+(.*)$/;

export interface ParsedChecklist {
  items: ChecklistItem[];
  lines: string[];
}

export function parseChecklist(content: string): ParsedChecklist {
  const lines = content.split(/\r?\n/);
  const items: ChecklistItem[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const m = ITEM_RE.exec(line);
    if (!m) continue;
    const indentStr = m[1] ?? "";
    const mark = m[2] ?? " ";
    const text = m[3] ?? "";
    items.push({
      done: mark.toLowerCase() === "x",
      text: text.trim(),
      indent: indentStr.length,
      lineIndex: i,
    });
  }
  return { items, lines };
}

export interface Progress {
  done: number;
  total: number;
  ratio: number;
}

export function progress(items: ChecklistItem[]): Progress {
  const total = items.length;
  const done = items.filter((i) => i.done).length;
  return { done, total, ratio: total === 0 ? 0 : done / total };
}

export function setItemDone(
  lines: string[],
  item: ChecklistItem,
  done: boolean,
): string[] {
  const line = lines[item.lineIndex];
  if (line === undefined) {
    throw new Error(`Invalid lineIndex: ${item.lineIndex}`);
  }
  const updated = line.replace(/^(\s*)-\s+\[[ xX]\]/, `$1- [${done ? "x" : " "}]`);
  const next = lines.slice();
  next[item.lineIndex] = updated;
  return next;
}

export function joinLines(lines: string[]): string {
  return lines.join("\n");
}

/**
 * 체크된(`[x]`) 항목들 중 마지막 줄 바로 다음에 새 `[x]` 항목들을 삽입.
 * - 체크된 항목이 하나도 없으면 마지막 체크리스트 항목 다음에 삽입
 * - 체크리스트 항목 자체가 없으면 파일 끝에 추가
 * 들여쓰기는 기준 항목의 indent를 따른다.
 */
export function appendCheckedItems(
  parsed: ParsedChecklist,
  texts: string[],
): { lines: string[]; insertedCount: number } {
  if (texts.length === 0) return { lines: parsed.lines, insertedCount: 0 };

  const { items, lines } = parsed;
  // 1. 마지막 done 항목 우선
  let anchor: ChecklistItem | undefined = [...items]
    .reverse()
    .find((i) => i.done);
  // 2. 없으면 마지막 항목 아무거나
  if (!anchor && items.length > 0) anchor = items[items.length - 1];

  const indent = anchor ? " ".repeat(anchor.indent) : "";
  const newLines = texts.map((t) => `${indent}- [x] ${t.trim()}`);

  const next = lines.slice();
  if (anchor) {
    next.splice(anchor.lineIndex + 1, 0, ...newLines);
  } else {
    // 체크리스트 항목 자체가 없으면 파일 끝에 추가
    if (next.length > 0 && next[next.length - 1] !== "") next.push("");
    next.push(...newLines);
  }
  return { lines: next, insertedCount: newLines.length };
}
