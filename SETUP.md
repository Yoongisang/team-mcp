# Team MCP Setup Guide

이 문서는 신규 팀원 PC에 `team-mcp`를 설치하고 Claude Code, Codex, Cursor에
연결하는 절차다.

## 1. 역할 확인

### 일반 팀원

사용 가능:

- 플랜과 체크리스트 조회·수정
- 작업 완료 처리
- 회의 준비
- Discord 회의 참여

필요한 값:

- `GAME_PROJECT_PATH`
- `GIT_REPORT_REF`
- `GIT_AUTHOR_MAP` 또는 호출 시 `git_author`
- `DISCORD_BOT_TOKEN`
- `DISCORD_SCRUM_CHANNEL_ID`
- Discord 태그명

### PM/팀장

추가 사용 가능:

- 회의 완료
- Notion 회의록 생성
- Jira 백로그 미리보기와 확정
- Jira 이슈 생성·수정·스프린트 배정

추가로 필요한 값:

- `NOTION_*`
- `JIRA_*`
- `ALLOWED_USERS`

일반 팀원 PC에서는 PM 전용 값을 비워둔다.

## 2. 사전 요구 사항

- Node.js 20 이상
- Git
- Claude Code, Codex, Cursor 중 사용할 AI 도구
- 로컬에 clone된 게임 레포
- 게임 레포를 읽고 쓸 수 있는 권한

버전 확인:

```bash
node --version
git --version
```

## 3. team-mcp 설치

```bash
git clone https://github.com/Yoongisang/team-mcp.git
cd team-mcp
npm install
npm run build
```

설치 검증:

```bash
npx tsx src/smoke.ts
```

정상 출력:

```text
[smoke] meeting thread selection passed
```

## 4. 게임 레포 준비

`prepare_meeting`은 `GAME_PROJECT_PATH`에서 현재 브랜치의 원격 upstream을 확인하고,
`GIT_REPORT_REF` 이후 upstream에 push된 회의 준비자의 Git 작성자 커밋만 수집한다.
기본 비교 기준 ref는 `origin/develop`이다.

```bash
cd /path/to/GameProject
git fetch
git rev-parse origin/develop
git rev-parse @{upstream}
```

개인 커밋 확인:

```bash
git log origin/develop..@{upstream} --author="Git author 이름 또는 이메일"
```

동작 기준:

- Discord 보고자를 Git author와 연결해 개인 커밋만 수집
- 이전에 보고한 HEAD는 현재 브랜치 upstream + 작성자별로 독립 추적
- 현재 브랜치 upstream에 push된 코드와 에셋 커밋을 모두 포함
- upstream에 반영되지 않은 해당 작성자의 로컬 커밋만 제외
- `GIT_REPORT_REF`는 작업 범위의 시작점이며 push 판정에는 사용하지 않음
- 최초 실행은 최근 7일의 해당 작성자 커밋 수집
- 한 번에 해당 작성자의 신규 커밋이 200건을 넘으면 오류로 중단

게임 레포 루트에는 다음 파일이 있어야 한다.

```text
AGENTS.md
기획서.md
내파트.md
플랜.md
체크리스트.md
```

기존 팀 프로젝트라면 게임 레포에 들어 있는 최신 `AGENTS.md`와 기획 파일을 그대로
사용한다. 파일이 없을 때만 `team-mcp/AGENTS.md`의 자연어 매핑 규칙을 게임 레포의
규칙과 병합한다. 기존 게임 규칙을 덮어쓰지 않는다.

완전 신규 프로젝트라서 `기획서.md`, `내파트.md`, `플랜.md`, `체크리스트.md`가
없다면 다음 순서로 최초 1회 생성한다.

1. `create_plan({ spec_content, my_part_content })`로 기획서와 담당 파트를 저장한다.
2. 반환된 컨텍스트를 AI가 분석한다.
3. `create_plan({ plan_markdown, checklist_markdown })`으로 플랜과 체크리스트를 저장한다.

게임 레포 `.gitignore`에는 다음을 추가한다.

```gitignore
.scrum-state.json
```

이 파일은 작성자별 마지막 보고 HEAD, 현재 회의, 백로그 승인 대기 상태를 저장한다.
백로그 미리보기를 만든 환경과 확정 명령을 실행하는 환경이 다르면 승인 상태를 찾지
못할 수 있다.

## 5. 환경변수 설정

`team-mcp` 디렉토리에서 `.env`를 만든다.

Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

macOS/Linux:

```bash
cp .env.example .env
```

### 일반 팀원

```dotenv
GAME_PROJECT_PATH=C:\projects\GameProject
GIT_REPORT_REF=origin/develop
GIT_AUTHOR_MAP={"Discord닉네임":"GitAuthorName"}

DISCORD_BOT_TOKEN=
DISCORD_USER_ID=
DISCORD_SCRUM_CHANNEL_ID=
DISCORD_TAG_IN_PROGRESS=진행
DISCORD_TAG_COMPLETED=완료
DISCORD_TAG_SUMMARY=정리
```

- `GAME_PROJECT_PATH`는 각 팀원 PC의 절대 경로다.
- `GIT_REPORT_REF`는 개인 작업 커밋을 수집할 때 사용하는 비교 시작 ref다.
- `GIT_AUTHOR_MAP`은 Discord 표시명과 Git author가 다를 때 사용한다. 값은 이름이나 이메일이다.
- `DISCORD_USER_ID`는 현재 핵심 MCP 로직에서 직접 읽지는 않지만 Channels 연동과
  사용자 식별 설정을 위해 기록한다.
- 태그명을 변경하지 않았다면 기본값을 그대로 사용한다.

### PM/팀장 추가 설정

```dotenv
NOTION_API_KEY=
NOTION_PARENT_PAGE_ID=
NOTION_LOCK_DB_ID=

JIRA_API_TOKEN=
JIRA_EMAIL=
JIRA_HOST=your-domain.atlassian.net
JIRA_PROJECT_KEY=
JIRA_TASK_TYPE=Task

ALLOWED_USERS=123456789012345678,987654321098765432
```

- `ALLOWED_USERS`에는 username이 아니라 Discord snowflake ID를 넣는다.
- `finish_meeting`과 `apply_meeting_to_backlog`는 이 목록으로 권한을 검사한다.
- `.env`는 절대 Git에 커밋하지 않는다.
- Bot/Jira/Notion 토큰은 비밀 관리 수단으로 전달한다.

현재 구조는 각 PC에서 로컬 MCP 서버가 Discord API를 직접 호출하므로
`prepare_meeting`을 실행하는 팀원 PC에도 Discord Bot 토큰이 필요하다. 팀원에게
Bot 토큰을 배포하지 않으려면 MCP를 중앙 실행 환경으로 운영해야 한다.

## 6. Discord 사전 준비

PM이 최초 1회 설정한다.

1. 회의용 Discord 포럼 채널을 만든다.
2. 포럼에 정확히 다음 태그를 만든다.

```text
진행
완료
정리
```

3. 포럼 채널 ID를 `DISCORD_SCRUM_CHANNEL_ID`에 설정한다.
4. Bot에 다음 권한을 부여한다.

- View Channel
- Send Messages
- Create Public Threads
- Send Messages in Threads
- Read Message History
- Manage Threads

`Manage Threads`는 스레드 이름, 보관 상태, 태그를 변경할 때 필요하다.

## 7. Notion 사전 준비

PM/팀장만 설정한다.

1. 회의록 부모 페이지를 만들고 ID를 `NOTION_PARENT_PAGE_ID`에 설정한다.
2. 락 데이터베이스를 만들고 다음 속성을 둔다.

| 속성 | 타입 |
|---|---|
| `Name` | Title |
| `expires_at` | Date |

3. DB ID를 `NOTION_LOCK_DB_ID`에 설정한다.
4. Notion Integration에 회의록 부모 페이지와 락 DB 접근 권한을 부여한다.
5. Integration 토큰을 `NOTION_API_KEY`에 설정한다.

## 8. Jira 사전 준비

PM/팀장만 설정한다.

1. Jira API 토큰과 이메일을 `JIRA_API_TOKEN`, `JIRA_EMAIL`에 설정한다.
2. `JIRA_HOST`에는 `https://` 없이 호스트만 입력한다.
3. 프로젝트 키를 `JIRA_PROJECT_KEY`에 설정한다.
4. 기본 이슈 타입을 `JIRA_TASK_TYPE`에 설정한다. 기본값은 `Task`다.
5. 자동 스프린트 배정을 사용하려면 Jira Software 스크럼 보드가 있어야 한다.
6. API 계정에 이슈 생성·수정·전환과 스프린트 이슈 추가 권한을 부여한다.

Jira 적용 정책:

- 새 작업, 후속 조치, 피드백 반영, 추가 수정은 기본적으로 새 이슈 생성
- 기존 이슈의 담당자·일정·스프린트·상태 변경은 회의에서 명시한 경우만 적용
- 기존 이슈 댓글은 명시적인 `comment_only` 요청에서만 작성
- `dueDate`가 있는 `create` 또는 `schedule`은 날짜에 맞는 스프린트로 자동 배정

## 9. MCP 등록

`dist/server.js`의 절대 경로를 사용한다.
등록 형식 참고: [Claude Code MCP](https://docs.anthropic.com/en/docs/claude-code/mcp),
[Cursor MCP](https://docs.cursor.com/context/model-context-protocol).

### Claude Code

Windows:

```powershell
claude mcp add team-mcp --scope user -- `
  "C:/Program Files/nodejs/node.exe" `
  "C:/absolute/path/team-mcp/dist/server.js"
```

macOS/Linux:

```bash
claude mcp add team-mcp --scope user -- node /absolute/path/team-mcp/dist/server.js
```

확인:

```bash
claude mcp list
```

### Codex

CLI 등록:

Windows:

```powershell
codex.cmd mcp add team-mcp -- node C:/absolute/path/team-mcp/dist/server.js
codex.cmd mcp list
```

macOS/Linux:

```bash
codex mcp add team-mcp -- node /absolute/path/team-mcp/dist/server.js
codex mcp list
```

수동 등록이 필요하면 `~/.codex/config.toml`에 다음을 추가한다.

```toml
[mcp_servers.team-mcp]
command = "node"
args = ["C:/absolute/path/team-mcp/dist/server.js"]
```

### Cursor

게임 레포의 `.cursor/mcp.json`은 프로젝트 설정이고, 사용자 홈의
`~/.cursor/mcp.json`은 전역 설정이다. 둘 중 하나에 다음을 추가한다.

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

등록 또는 빌드 후 AI 도구를 완전히 재시작한다.

## 10. 연결 확인

1. AI 도구에서 MCP 서버가 연결됐는지 확인한다.
2. `"팀 규칙 보여줘"` 또는 `get_team_rules`를 실행한다.
3. `"진행 상황 보여줘"` 또는 `show_progress`를 실행한다.
4. 게임 레포 경로와 체크리스트가 정상적으로 읽히는지 확인한다.

PM은 별도로 권한 전달을 검증한다.

1. Discord 메시지 메타데이터의 `author.id`를 `invoker_id`로 사용한다.
2. username이나 표시 이름을 `finish_meeting.invoker_id`로 전달하지 않는다.
3. 테스트 포럼에서 회의 준비·완료 흐름을 한 번 실행한다.

## 11. 실제 회의 흐름

### 회의 준비

1. `prepare_meeting({ user_name })` 호출
   - 이름이 다르면 `GIT_AUTHOR_MAP`을 설정하거나 `git_author`를 함께 전달
2. 체크리스트 완료 후보가 있으면 완료 항목 확인
3. 기준 ref 이후 현재 upstream에 push된 해당 작성자의 커밋을 AI가 검토해 `commit_summary_markdown` 작성
4. `prepare_meeting` 재호출
5. 오늘 `[진행]` 회의가 있으면 댓글로 추가
6. 없으면 `스크럼 회의 YYYY-MM-DD (N차)` 생성

서울 날짜 기준으로 오늘의 최신 `[진행]` 스레드만 사용한다. 어제 끝나지 않은 회의에는
붙지 않는다.

### 회의 완료

1. `finish_meeting({ invoker_id })` 호출
2. 오늘의 최신 `[진행]` 스레드 댓글을 AI가 분석
3. `summary`, `action_items`와 함께 재호출
4. Notion 회의록 생성
5. 원본 스레드를 `[완료]`로 변경
6. 같은 회차의 `[정리]` 스레드 생성
7. Jira에는 아직 아무것도 생성하거나 수정하지 않음

### Jira 반영

1. 회의 완료 후 사용자가 `"진행"` 또는 `"Jira 진행"`을 요청
2. `apply_meeting_to_backlog({ invoker_id })`로 회의와 Jira 컨텍스트 수집
3. AI가 `proposals`를 작성하되 담당자가 명확하면 Discord 표시 이름을 `assigneeName`으로 사용
4. `proposals`로 재호출
5. 방금 생성된 Discord `[정리]` 스레드 댓글에 Jira 반영 미리보기와 담당자 매칭 결과 게시
6. PM/팀장이 미리보기를 확인
7. `"승인"` 또는 `"백로그 변경 확정해줘"` 명령으로 `confirm: true` 호출
8. 승인된 내용만 Jira에 일괄 반영하고 표시 이름에 맞는 담당자를 배정
9. 적용 결과를 같은 `[정리]` 스레드에 게시

같은 회의에서 후속 미리보기를 만들면 해당 회의의 `[정리]` 스레드 댓글로 이어진다.
승인 대기는 24시간 후 만료된다.

## 12. Channels 자동화 모드

Discord 메시지로 Claude Code를 깨워 MCP를 호출하려면 PM의 상시 실행 환경이 필요하다.

1. Discord Developer Portal에서 Message Content Intent를 활성화한다.
2. Claude Code Channels용 Discord 플러그인을 설치하고 페어링한다.
3. 게임 레포 루트에서 백그라운드 Claude Code 세션을 실행한다.
4. Channels allowlist에 명령 가능한 사용자만 등록한다.

시작 디렉토리는 게임 레포 루트여야 `AGENTS.md`와 프로젝트 파일을 읽을 수 있다.
백그라운드 세션이 꺼져 있을 때 들어온 메시지는 처리되지 않을 수 있다.

## 13. 업데이트

```bash
cd /path/to/team-mcp
git pull
npm install
npm run build
npx tsx src/smoke.ts
```

업데이트 후 AI 도구를 완전히 재시작한다.

## 14. 문제 해결

### `Git 보고 기준 ref를 찾을 수 없습니다`

```bash
git fetch
git rev-parse origin/develop
```

다른 ref를 사용한다면 `.env`의 `GIT_REPORT_REF`를 변경한다.

### `Git 작성자 매칭 필요`

도구가 반환한 후보에서 올바른 Git author를 확인한 뒤 `.env`에 매핑한다.

```dotenv
GIT_AUTHOR_MAP={"Discord표시명":"GitAuthorName"}
```

### `오늘 진행 중인 회의 스레드가 없습니다`

먼저 `prepare_meeting`을 실행한다. 어제의 `[진행]` 스레드는 재사용하지 않는다.

### `권한 없음`

`invoker_id`가 Discord username이 아닌 snowflake ID인지 확인하고, PM PC의
`ALLOWED_USERS`에 포함됐는지 확인한다.

### `포럼 태그를 찾을 수 없음`

Discord 포럼에 `진행`, `완료`, `정리` 태그가 실제로 존재하는지 확인한다.

### 코드 변경이 MCP에 반영되지 않음

```bash
npm run build
```

그 뒤 AI 도구를 완전히 재시작한다.

### 백로그 승인 대기를 찾을 수 없음

미리보기를 만든 MCP 환경과 확정 명령을 실행한 환경이 같은지 확인한다.
`.scrum-state.json`은 로컬 상태 파일이다.
