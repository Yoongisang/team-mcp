# Auto Setup Guide for AI Tools

이 파일은 AI 도구(Claude Code · Codex · Cursor)가 읽고 자동 세팅하기 위한 지시서.

## 세팅 절차

1. `npm install` 실행
2. `npm run build` 실행 (TypeScript 컴파일 → `dist/`)
3. `.env.example`을 `.env`로 복사
4. 사용자에게 다음 값 입력 받기:
   - `GAME_PROJECT_PATH` — 게임 레포 절대 경로 (예: `C:\Users\me\projects\EternalDreams`)
   - `DISCORD_BOT_TOKEN` (PM이 공유)
   - `DISCORD_USER_ID` (본인)
   - `DISCORD_SCRUM_CHANNEL_ID`, `DISCORD_ARCHIVE_CHANNEL_ID`
   - `NOTION_API_KEY`, `NOTION_PARENT_PAGE_ID`, `NOTION_LOCK_DB_ID` (PM/팀장만)
   - `JIRA_API_TOKEN`, `JIRA_EMAIL`, `JIRA_HOST`, `JIRA_PROJECT_KEY` (PM/팀장만)
   - `ALLOWED_USERS` (PM/팀장 Discord ID 목록, 콤마 구분)
5. 현재 도구 설정 파일에 MCP 서버 등록:

### Claude Code — `.claude/settings.json`

```json
{
  "mcpServers": {
    "team-mcp": {
      "command": "node",
      "args": ["<absolute-path-to>/team-mcp/dist/server.js"]
    }
  }
}
```

### Codex — `~/.codex/config.toml`

```toml
[mcp_servers.team-mcp]
command = "node"
args = ["<absolute-path-to>/team-mcp/dist/server.js"]
```

### Cursor — `.cursor/mcp.json`

```json
{
  "mcpServers": {
    "team-mcp": {
      "command": "node",
      "args": ["<absolute-path-to>/team-mcp/dist/server.js"]
    }
  }
}
```

6. 테스트:
   - 도구 재시작
   - `"진행 상황 보여줘"` 또는 `show_progress` 직접 호출 → 정상 응답이면 OK

## Notion 사전 준비 (PM/팀장만)

`finish_meeting`이 동작하려면 Notion에 다음을 미리 만든다:

1. **회의록 부모 페이지**: 일반 페이지 1개. ID를 `NOTION_PARENT_PAGE_ID`에 입력.
2. **락 데이터베이스**: 다음 두 컬럼을 가진 DB:
   - `Name` (기본 title 컬럼)
   - `expires_at` (Date 타입)

   DB ID를 `NOTION_LOCK_DB_ID`에 입력.
3. Notion Integration 토큰을 두 페이지·DB 모두에 공유 권한 부여.

## Channels 자동화 모드 (선택)

Discord 채널에 "회의 완료" 같은 한 줄을 입력하면 Claude가 자동으로 우리 MCP 툴을 호출하게 만드는 모드. PM 한 명의 머신에서 백그라운드 세션을 상시 운영해야 한다.

### 사전 준비 (PM 1회)

1. 디스코드 봇에 다음 권한·인텐트 부여:
   - **Message Content Intent** 활성화 (Developer Portal → Bot 탭)
   - 채널 권한: `View Channels`, `Send Messages`, `Send Messages in Threads`, `Read Message History`, `Add Reactions`, `Attach Files`
   - 본 MCP 서버에서 이미 같은 봇 토큰을 사용 중이면 봇은 추가로 만들 필요 없음. 권한·인텐트만 보강.
2. Claude Code v2.1.80+ 확인
3. Channels Discord 플러그인 설치 + 페어링
   ```bash
   /plugin install discord@claude-plugins-official
   /discord:configure <BOT_TOKEN>
   # 봇과 DM해서 페어링 코드 받은 뒤
   /discord:access pair <코드>
   /discord:access policy allowlist
   ```
4. 게임 레포 디렉토리에서 백그라운드 상시 세션 시작:
   ```bash
   # macOS/Linux
   tmux new -s team-mcp 'cd /path/to/EternalDreams && claude --channels plugin:discord@claude-plugins-official'

   # Windows
   # 작업 스케줄러로 시작 시 다음 명령 등록 (cmd 창 유지):
   # cd C:\path\to\EternalDreams && claude --channels plugin:discord@claude-plugins-official
   ```
   - 시작 디렉토리는 반드시 **게임 레포 루트**여야 한다 (`.claude/settings.json` + `AGENTS.md` 적용).
5. 권한 중계 옵션: 도구 호출 승인을 Discord로 받고 싶으면 `claude/channel/permission` 활성화 (Channels 문서 참고).

### 자동 모드의 한계

- 백그라운드 세션이 꺼져 있을 때 디스코드 메시지는 큐잉되지 않고 사라진다.
- 트리거 권한자(allowlist)에 등록된 ID만 명령을 보낼 수 있다.
- Channels에서 들어오는 메시지의 `author.id`(Discord snowflake)를 그대로 `invoker_id` 인자로 사용해야 `ALLOWED_USERS` 검증과 일치한다. 처음 페어링 후 `finish_meeting` 한 번 시도해서 실제로 ID가 정확히 전달되는지 확인 권장.

### 의도 매핑 안내

자동 모드를 안정적으로 쓰려면 **게임 레포의 `AGENTS.md`**에 트리거 매핑 섹션을 추가한다. 본 레포의 [examples/AGENTS.example.md](examples/AGENTS.example.md) 참고.

## 주의사항

- `.env`는 절대 git에 커밋하지 않음 (`.gitignore`에 포함됨)
- PM/팀장이 아닌 경우 `NOTION_*`, `JIRA_*`, `ALLOWED_USERS`는 비워둠
- `GAME_PROJECT_PATH`는 도구마다 다른 OS일 수 있으므로 호스트별 절대 경로 사용
- Windows에서는 경로 구분자로 백슬래시 또는 슬래시 모두 허용
