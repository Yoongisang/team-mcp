import { config as dotenvConfig } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// dist/config.js 기준 상위 디렉토리(team-mcp 루트)의 .env
dotenvConfig({ path: resolve(__dirname, "../.env"), override: true });

const env = (key: string): string => process.env[key] ?? "";

export const config = {
  get gameProjectPath() {
    return env("GAME_PROJECT_PATH");
  },
  discord: {
    get botToken() {
      return env("DISCORD_BOT_TOKEN");
    },
    get userId() {
      return env("DISCORD_USER_ID");
    },
    /** 회의 포럼 채널 ID. 진행/완료/정리 태그가 모두 여기에 있어야 함. */
    get scrumChannelId() {
      return env("DISCORD_SCRUM_CHANNEL_ID");
    },
    /** 포럼 태그명 — 기본값 사용 시 포럼에 정확히 이 이름으로 태그를 만들어둬야 함. */
    get tagInProgress() {
      return env("DISCORD_TAG_IN_PROGRESS") || "진행";
    },
    get tagCompleted() {
      return env("DISCORD_TAG_COMPLETED") || "완료";
    },
    get tagSummary() {
      return env("DISCORD_TAG_SUMMARY") || "정리";
    },
  },
  notion: {
    get apiKey() {
      return env("NOTION_API_KEY");
    },
    get parentPageId() {
      return env("NOTION_PARENT_PAGE_ID");
    },
    get lockDbId() {
      return env("NOTION_LOCK_DB_ID");
    },
  },
  jira: {
    get apiToken() {
      return env("JIRA_API_TOKEN");
    },
    get email() {
      return env("JIRA_EMAIL");
    },
    get host() {
      return env("JIRA_HOST");
    },
    get projectKey() {
      return env("JIRA_PROJECT_KEY");
    },
    get taskType() {
      return env("JIRA_TASK_TYPE") || "Task";
    },
  },
  get allowedUsers() {
    return env("ALLOWED_USERS")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  },
};

export function requireConfig(value: string, name: string): string {
  if (!value) {
    throw new Error(
      `Missing required env var: ${name}. Set it in .env (see .env.example).`,
    );
  }
  return value;
}
