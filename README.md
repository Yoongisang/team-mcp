# Team MCP Server

UE5 팀 프로젝트의 계획, 체크리스트, Discord 스크럼, Notion 회의록, Jira 액션을
Claude Code, Codex, Cursor에서 같은 방식으로 다루는 로컬 MCP 서버다.

## 주요 동작

- 게임 레포의 현재 브랜치 upstream에 push된 커밋만 회의 보고에 포함한다.
- 커밋 원문은 AI 검토 컨텍스트로만 사용하고 Discord에는 정리된 요약을 게시한다.
- 체크리스트 완료는 자동 반영하지 않고 사용자 확인을 거친다.
- 회의 준비와 완료는 서울 날짜 기준 최신 `[진행]` 스레드를 사용한다.
- 하루에 여러 회의를 열면 `스크럼 회의 YYYY-MM-DD (N차)`로 구분한다.
- 새 회의 액션은 기본적으로 새 Jira Task로 제안하고, 미리보기 확인 후 발행한다.

## 요구 사항

- Node.js 20 이상
- Git
- 로컬에 clone된 게임 레포
- upstream이 설정된 게임 레포 작업 브랜치
- Discord 포럼 채널과 Bot
- PM 기능 사용 시 Notion Integration과 Jira API 자격 증명

## 빠른 시작

```bash
git clone https://github.com/Yoongisang/team-mcp.git
cd team-mcp
npm install
npm run build
cp .env.example .env
```

Windows PowerShell에서는 마지막 명령 대신 다음을 사용할 수 있다.

```powershell
Copy-Item .env.example .env
```

일반 팀원의 최소 `.env`:

```dotenv
GAME_PROJECT_PATH=C:\projects\GameProject
DISCORD_BOT_TOKEN=
DISCORD_USER_ID=
DISCORD_SCRUM_CHANNEL_ID=
DISCORD_TAG_IN_PROGRESS=진행
DISCORD_TAG_COMPLETED=완료
DISCORD_TAG_SUMMARY=정리
```

`DISCORD_USER_ID`는 현재 핵심 MCP 호출에서 직접 읽지는 않지만 Channels 연동과
사용자 식별 설정을 위해 기록한다.

PM/팀장 PC에는 다음 값도 설정한다.

```dotenv
NOTION_API_KEY=
NOTION_PARENT_PAGE_ID=
NOTION_LOCK_DB_ID=

JIRA_API_TOKEN=
JIRA_EMAIL=
JIRA_HOST=
JIRA_PROJECT_KEY=
JIRA_TASK_TYPE=Task

ALLOWED_USERS=PM_DISCORD_ID,LEAD_DISCORD_ID
```

토큰이 들어 있는 `.env`는 Git에 커밋하지 않는다. Discord Bot 토큰과 Jira/Notion
토큰은 채팅이나 문서로 공유하지 말고 비밀 관리 수단으로 전달한다.

전체 설치와 서비스별 사전 준비는 [SETUP.md](SETUP.md)를 참고한다.

## MCP 등록

등록 형식 참고: [Claude Code MCP](https://docs.anthropic.com/en/docs/claude-code/mcp),
[Cursor MCP](https://docs.cursor.com/context/model-context-protocol).

Claude Code:

```bash
claude mcp add team-mcp --scope user -- node /absolute/path/team-mcp/dist/server.js
claude mcp list
```

Codex:

```bash
codex mcp add team-mcp -- node /absolute/path/team-mcp/dist/server.js
codex mcp list
```

Windows PowerShell에서는 `codex` 대신 `codex.cmd`를 사용할 수 있다. 수동 등록이
필요하면 `~/.codex/config.toml`에 다음을 추가한다.

```toml
[mcp_servers.team-mcp]
command = "node"
args = ["C:/absolute/path/team-mcp/dist/server.js"]
```

Cursor는 게임 레포의 `.cursor/mcp.json` 또는 사용자 홈의 `~/.cursor/mcp.json`에
다음을 추가한다.

```json
{
  "mcpServers": {
    "team-mcp": {
      "command": "node",
      "args": ["C:/absolute/path/team-mcp/dist/server.js"]
    }
  }
}
```

등록 후 AI 도구를 완전히 재시작한다.

## 제공 도구

| 도구 | 역할 |
|---|---|
| `get_team_rules` | 게임 레포의 팀 규칙 조회 |
| `show_progress` | 체크리스트 진행률과 예상 완료일 조회 |
| `create_plan` | 기획서와 담당 파트를 바탕으로 플랜·체크리스트 생성 |
| `complete_task` | 사용자가 지정한 체크리스트 항목 완료 처리 |
| `change_direction` | 방향 변경의 영향 분석 |
| `update_plan` | 플랜과 체크리스트 수정 |
| `prepare_meeting` | push된 변경을 검토·요약해 오늘의 최신 회의에 게시 |
| `finish_meeting` | 오늘의 최신 회의를 완료하고 Notion 회의록·정리 스레드 생성 |
| `apply_meeting_to_backlog` | Jira 액션 미리보기, 승인, 신규 발행 및 명시적 기존 이슈 변경 |

## 회의 흐름

```text
prepare_meeting
  -> 체크리스트 완료 후보가 있으면 사용자 확인
  -> push된 커밋을 AI가 검토하고 요약
  -> 오늘의 최신 [진행] 스레드에 게시하거나 새 N차 회의 생성

finish_meeting
  -> 오늘의 최신 [진행] 스레드 댓글 수집
  -> AI 요약 재호출
  -> Notion 회의록 생성
  -> 원본 [완료] 처리
  -> 같은 회차의 [정리] 스레드 생성

apply_meeting_to_backlog
  -> 회의와 Jira 전체 분석
  -> Discord 백로그 업데이트 미리보기 게시
  -> PM/팀장이 "백로그 변경 확정해줘"라고 명령
  -> Jira에 일괄 반영
```

같은 회의에서 백로그 미리보기를 다시 만들면 기존 미리보기 포스트의 댓글로 이어진다.
승인은 reaction이 아니라 권한 있는 사용자의 텍스트 명령으로 처리한다.

Jira 제안 원칙:

- 새 작업, 후속 조치, 피드백 반영, 추가 수정은 기본적으로 `create`
- `assign`, `schedule`, `move_to_sprint`, `reopen`은 기존 이슈 자체를 변경하기로
  명확히 결정한 경우에만 사용
- `comment_only`는 사용자가 기존 이슈에 기록만 남기라고 명시한 경우에만 사용
- `create` 또는 `schedule`에 `dueDate`가 있으면 해당 날짜 기준 스프린트를 찾거나
  생성해 자동 배정

## Git 수집 기준

`prepare_meeting`은 Discord 닉네임이나 Git author로 필터링하지 않는다.

1. `GAME_PROJECT_PATH`의 현재 브랜치와 upstream을 확인한다.
2. 로컬 상태에 저장된 이전 보고 HEAD부터 현재 upstream HEAD까지 수집한다.
3. upstream에 없는 로컬 커밋은 제외하고 개수만 표시한다.
4. 이전 보고 HEAD가 없는 최초 실행은 최근 7일의 upstream 커밋을 수집한다.

```bash
git branch --show-current
git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}'
git push -u origin <branch-name>
```

Git은 커밋이 어느 PC에서 push됐는지 기록하지 않는다. 이 서버에서 말하는
"push된 커밋"은 현재 PC의 게임 레포가 알고 있는 upstream ref에 포함된 커밋이다.

## 게임 레포 파일

MCP는 `GAME_PROJECT_PATH` 아래의 다음 파일을 사용한다.

- `AGENTS.md`
- `기획서.md`
- `내파트.md`
- `플랜.md`
- `체크리스트.md`
- `.scrum-state.json`

`.scrum-state.json`에는 로컬 회의 상태와 마지막 보고 upstream HEAD가 들어간다.
게임 레포의 `.gitignore`에 추가하고, 백로그 미리보기를 만든 PM과 확정하는 PM은
같은 MCP 환경을 사용하는 것이 안전하다.

## 업데이트와 검증

```bash
git pull
npm install
npm run build
npx tsx src/smoke.ts
```

빌드 후 연결된 Claude Code, Codex, Cursor를 재시작해야 새 `dist/server.js`가 적용된다.
