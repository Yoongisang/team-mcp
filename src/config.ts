import "dotenv/config";

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
    get scrumChannelId() {
      return env("DISCORD_SCRUM_CHANNEL_ID");
    },
    get archiveChannelId() {
      return env("DISCORD_ARCHIVE_CHANNEL_ID");
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
