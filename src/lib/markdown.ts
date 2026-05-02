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
