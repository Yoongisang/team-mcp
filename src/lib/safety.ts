export const DISCORD_MSG_LIMIT = 1900;

export function truncateForDiscord(
  text: string,
  limit = DISCORD_MSG_LIMIT,
): string {
  return text.length > limit
    ? text.slice(0, limit) + "\n... (이하 생략)"
    : text;
}

export function chunkForDiscord(
  text: string,
  limit = DISCORD_MSG_LIMIT,
): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const slice = remaining.slice(0, limit);
    let cut = slice.lastIndexOf("\n");
    if (cut < limit / 2) cut = slice.lastIndexOf(" ");
    if (cut <= 0) cut = limit;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^[\n ]+/, "");
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

export function checkPermission(
  invokerId: string,
  allowedUsers: string[],
): void {
  if (allowedUsers.length === 0) {
    throw new Error(
      "ALLOWED_USERS 비어있음. PM/팀장 Discord ID를 .env에 등록 필요.",
    );
  }
  if (!allowedUsers.includes(invokerId)) {
    throw new Error(
      `권한 없음: invoker_id "${invokerId}"는 ALLOWED_USERS에 등록되지 않음.`,
    );
  }
}

export interface ArchiveResult {
  archived: number;
  source: number;
}

export async function safeArchive<T>(
  items: T[],
  archive: (items: T[]) => Promise<unknown[]>,
  deleteOriginals: () => Promise<void>,
): Promise<ArchiveResult> {
  if (items.length === 0) return { archived: 0, source: 0 };

  const archived = await archive(items);
  if (archived.length !== items.length) {
    throw new Error(
      `아카이브 검증 실패: 원본 ${items.length}건 / 사본 ${archived.length}건. 원본 유지.`,
    );
  }
  await deleteOriginals();
  return { archived: archived.length, source: items.length };
}
