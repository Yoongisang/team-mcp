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

export type BacklogProposalAction =
  | "assign"
  | "schedule"
  | "move_to_sprint"
  | "comment_only"
  | "reopen";

export interface BacklogProposal {
  issueKey: string;
  action: BacklogProposalAction;
  assigneeName?: string;    // 표시 이름 (예: "김민수"). MCP가 accountId 조회
  startDate?: string;       // YYYY-MM-DD
  dueDate?: string;         // YYYY-MM-DD
  sprintId?: number;
  comment?: string;         // 회의 출처/맥락 노트
}

export interface PendingBacklogApproval {
  /** Discord 정리 스레드 ID — 봇이 미리보기 메시지를 게시한 스레드. */
  threadId: string;
  /** 미리보기 메시지 ID — 이 메시지의 ✅ reaction을 검사. */
  messageId: string;
  /** 적용할 proposals 원본. */
  proposals: BacklogProposal[];
  /** ISO 타임스탬프. 24시간 후 자동 만료. */
  createdAt: string;
}

export interface ScrumState {
  completions: Completion[];
  lastPrepareMeetingAt: string | null;
  /** 진행 중인 포럼 회의 스레드 ID. prepare_meeting이 설정, finish_meeting이 클리어. */
  currentMeetingThreadId: string | null;
  /** 직전 회의 스레드 ID. finish_meeting이 클리어 직전 백업 → apply_meeting_to_backlog가 참조. */
  lastFinishedMeetingThreadId: string | null;
  /** 사용자 확인 대기 중인 체크리스트 항목. finish_meeting에서 처리 후 클리어. */
  pendingConfirmations: PendingConfirmation[];
  /** apply_meeting_to_backlog Phase 2에서 저장, Phase 3에서 확인 후 클리어. */
  pendingBacklogApproval: PendingBacklogApproval | null;
}

const DEFAULT_STATE: ScrumState = {
  completions: [],
  lastPrepareMeetingAt: null,
  currentMeetingThreadId: null,
  lastFinishedMeetingThreadId: null,
  pendingConfirmations: [],
  pendingBacklogApproval: null,
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
      lastFinishedMeetingThreadId: parsed.lastFinishedMeetingThreadId ?? null,
      pendingConfirmations: Array.isArray(parsed.pendingConfirmations) ? parsed.pendingConfirmations : [],
      pendingBacklogApproval: parsed.pendingBacklogApproval ?? null,
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
