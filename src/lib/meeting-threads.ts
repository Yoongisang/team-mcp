import type { DiscordThread } from "./discord.js";

const MEETING_TITLE_PREFIX = "스크럼 회의";
const TEAM_TIME_ZONE = "Asia/Seoul";

export function currentMeetingDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TEAM_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

export function meetingSequence(name: string, date: string): number | null {
  const escapedDate = date.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `^${MEETING_TITLE_PREFIX}\\s+${escapedDate}(?:\\s+\\((\\d+)차\\))?$`,
  );
  const match = pattern.exec(name.trim());
  if (!match) return null;
  return match[1] ? Number(match[1]) : 1;
}

export function meetingThreadName(date: string, sequence: number): string {
  return `${MEETING_TITLE_PREFIX} ${date} (${sequence}차)`;
}

export function latestInProgressMeeting(
  threads: DiscordThread[],
  inProgressTagId: string,
  date: string,
): DiscordThread | undefined {
  return threads
    .filter(
      (thread) =>
        meetingSequence(thread.name, date) !== null &&
        thread.applied_tags?.includes(inProgressTagId),
    )
    .sort((a, b) => {
      try {
        const left = BigInt(a.id);
        const right = BigInt(b.id);
        return left === right ? 0 : left > right ? -1 : 1;
      } catch {
        return b.id.localeCompare(a.id);
      }
    })[0];
}

export function nextMeetingSequence(
  threads: DiscordThread[],
  date: string,
): number {
  const sequences = threads
    .map((thread) => meetingSequence(thread.name, date))
    .filter((sequence): sequence is number => sequence !== null);
  return sequences.length === 0 ? 1 : Math.max(...sequences) + 1;
}
