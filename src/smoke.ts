import assert from "node:assert/strict";
import {
  discordDisplayName,
  type DiscordMessage,
  type DiscordThread,
} from "./lib/discord.js";
import {
  gitReportTrackingKey,
  initialGitReportRevision,
  matchesGitAuthor,
} from "./lib/git.js";
import {
  currentMeetingDate,
  latestInProgressMeeting,
  meetingSequence,
  meetingThreadName,
  nextMeetingSequence,
} from "./lib/meeting-threads.js";
import { renderProposalsPreview } from "./tools/apply-meeting-to-backlog.js";
import { finishMeetingTool } from "./tools/finish-meeting.js";

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

const messageBase: Omit<DiscordMessage, "author" | "member"> = {
  id: "message",
  channel_id: "thread",
  content: "status",
  timestamp: "2026-07-27T12:00:00.000Z",
};
assert.equal(
  discordDisplayName({
    ...messageBase,
    author: {
      id: "user",
      username: "sawsd",
      global_name: "윤기상",
    },
    member: { nick: "팀장 윤기상" },
  }),
  "팀장 윤기상",
);
assert.equal(
  discordDisplayName({
    ...messageBase,
    author: {
      id: "user",
      username: "sawsd",
      global_name: "윤기상",
    },
  }),
  "윤기상",
);
assert.equal(
  discordDisplayName({
    ...messageBase,
    author: { id: "user", username: "sawsd" },
  }),
  "sawsd",
);

const jiraPreview = renderProposalsPreview(
  [
    {
      action: "create",
      summary: "세이브 시스템 테스트",
      assigneeName: "윤기상",
    },
    {
      action: "create",
      summary: "환경 코드 분석",
      assigneeName: "표시 이름 불일치",
    },
  ],
  new Map(),
  new Map([
    ["윤기상", "윤기상"],
    ["표시 이름 불일치", null],
  ]),
);
assert.match(jiraPreview, /윤기상 → Jira 윤기상 \(매칭 확인\)/);
assert.match(jiraPreview, /표시 이름 불일치 → Jira 매칭 실패/);

const finishProperties = (
  finishMeetingTool.inputSchema as {
    properties?: Record<string, unknown>;
  }
).properties ?? {};
assert.equal("create_action_issues" in finishProperties, false);
assert.equal("completed_task_names" in finishProperties, false);
assert.equal("sprint_end_date" in finishProperties, false);

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
assert.equal(
  initialGitReportRevision(
    "origin/develop",
    "origin/feature/save-persistence-0720",
  ),
  "origin/develop..origin/feature/save-persistence-0720",
);
assert.equal(
  initialGitReportRevision("origin/develop", "origin/develop"),
  "origin/develop",
);

console.log("[smoke] meeting thread and Git author selection passed");
