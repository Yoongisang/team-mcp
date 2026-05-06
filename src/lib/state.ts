import { gameFileExists, readGameFile, writeGameFile } from "./files.js";

export const STATE_FILE = ".scrum-state.json";

export interface Completion {
  task: string;
  completedAt: string;
}

export interface PendingConfirmation {
  index: number;       // 1-based, Discord 메시지에서 사용자가 입력할 번호
  itemText: string;    // 체크리스트 항목 텍스트
  commitSubject: string; // 매칭된 커밋 제목
}

export interface ScrumState {
  completions: Completion[];
  lastPrepareMeetingAt: string | null;
  /** 진행 중인 포럼 회의 스레드 ID. prepare_meeting이 설정, finish_meeting이 클리어. */
  currentMeetingThreadId: string | null;
  /** 사용자 확인 대기 중인 체크리스트 항목. finish_meeting에서 처리 후 클리어. */
  pendingConfirmations: PendingConfirmation[];
}

const DEFAULT_STATE: ScrumState = {
  completions: [],
  lastPrepareMeetingAt: null,
  currentMeetingThreadId: null,
  pendingConfirmations: [],
};

export async function loadState(): Promise<ScrumState> {
  if (!(await gameFileExists(STATE_FILE))) {
    return { ...DEFAULT_STATE, completions: [] };
  }
  try {
    const raw = await readGameFile(STATE_FILE);
    const parsed = JSON.parse(raw) as Partial<ScrumState>;
    return {
      completions: Array.isArray(parsed.completions) ? parsed.completions : [],
      lastPrepareMeetingAt: parsed.lastPrepareMeetingAt ?? null,
      currentMeetingThreadId: parsed.currentMeetingThreadId ?? null,
      pendingConfirmations: Array.isArray(parsed.pendingConfirmations) ? parsed.pendingConfirmations : [],
    };
  } catch {
    return { ...DEFAULT_STATE, completions: [] };
  }
}

export async function saveState(state: ScrumState): Promise<void> {
  await writeGameFile(STATE_FILE, JSON.stringify(state, null, 2), {
    overwrite: true,
  });
}

export function estimateCompletionDate(
  state: ScrumState,
  remainingItems: number,
  now: Date = new Date(),
): string | null {
  if (remainingItems === 0) return null;
  const cs = state.completions;
  if (cs.length < 2) return null;
  const first = Date.parse(cs[0]!.completedAt);
  const last = Date.parse(cs[cs.length - 1]!.completedAt);
  if (!Number.isFinite(first) || !Number.isFinite(last)) return null;
  const span = last - first;
  if (span <= 0) return null;
  const ratePerMs = cs.length / span;
  const msNeeded = remainingItems / ratePerMs;
  const eta = new Date(now.getTime() + msNeeded);
  return eta.toISOString().slice(0, 10);
}
