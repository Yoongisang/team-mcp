import assert from "node:assert/strict";
import type { DiscordThread } from "./lib/discord.js";
import {
  gitReportTrackingKey,
  matchesGitAuthor,
} from "./lib/git.js";
import {
  currentMeetingDate,
  latestInProgressMeeting,
  meetingSequence,
  meetingThreadName,
  nextMeetingSequence,
} from "./lib/meeting-threads.js";

const progressTag = "progress";
const completedTag = "completed";
const forumId = "forum";
const threads: DiscordThread[] = [
  {
    id: "100",
    name: "스크럼 회의 2026-07-27",
    parent_id: forumId,
    applied_tags: [completedTag],
  },
  {
    id: "101",
    name: "스크럼 회의 2026-07-27 (2차)",
    parent_id: forumId,
    applied_tags: [progressTag],
  },
  {
    id: "099",
    name: "스크럼 회의 2026-07-26 (9차)",
    parent_id: forumId,
    applied_tags: [progressTag],
  },
  {
    id: "102",
    name: "스크럼 회의 2026-07-27 (3차)",
    parent_id: forumId,
    applied_tags: [progressTag],
  },
];

assert.equal(
  currentMeetingDate(new Date("2026-07-26T16:00:00.000Z")),
  "2026-07-27",
);
assert.equal(meetingSequence("스크럼 회의 2026-07-27", "2026-07-27"), 1);
assert.equal(
  meetingSequence("스크럼 회의 2026-07-27 (3차)", "2026-07-27"),
  3,
);
assert.equal(
  meetingSequence("스크럼 회의 2026-07-26 (9차)", "2026-07-27"),
  null,
);
assert.equal(meetingThreadName("2026-07-27", 4), "스크럼 회의 2026-07-27 (4차)");
assert.equal(
  latestInProgressMeeting(threads, progressTag, "2026-07-27")?.id,
  "102",
);
assert.equal(
  latestInProgressMeeting(
    [
      {
        id: "9",
        name: "스크럼 회의 2026-07-27 (1차)",
        parent_id: forumId,
        applied_tags: [progressTag],
      },
      {
        id: "10",
        name: "스크럼 회의 2026-07-27 (2차)",
        parent_id: forumId,
        applied_tags: [progressTag],
      },
    ],
    progressTag,
    "2026-07-27",
  )?.id,
  "10",
);
assert.equal(
  latestInProgressMeeting(threads, progressTag, "2026-07-28"),
  undefined,
);
assert.equal(nextMeetingSequence(threads, "2026-07-27"), 4);

const yoongiCommit = {
  authorName: "Yoongisang",
  authorEmail: "sawsd@naver.com",
};
assert.equal(matchesGitAuthor(yoongiCommit, "Yoongisang"), true);
assert.equal(matchesGitAuthor(yoongiCommit, "sawsd@naver.com"), true);
assert.equal(matchesGitAuthor(yoongiCommit, "sawsd"), true);
assert.equal(matchesGitAuthor(yoongiCommit, "윤기상"), false);
assert.notEqual(
  gitReportTrackingKey("origin/develop", "Yoongisang"),
  gitReportTrackingKey("origin/develop", "정찬호"),
);

console.log("[smoke] meeting thread and Git author selection passed");
