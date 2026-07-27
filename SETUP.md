# Auto Setup Guide for AI Tools

이 파일은 AI 도구(Claude Code · Codex · Cursor)가 읽고 자동 세팅하기 위한 지시서.

## 세팅 절차

1. `npm install` 실행
2. `npm run build` 실행 (TypeScript 컴파일 → `dist/`)
3. `.env.example`을 `.env`로 복사
4. 사용자에게 다음 값 입력 받기:
   - `GAME_PROJECT_PATH` — 게임 레포 절대 경로 (예: `C:\Users\me\projects\EternalDreams`)
     - 현재 작업 브랜치에 upstream이 설정돼 있어야 함 (`git push -u <remote> <branch>`)
     - `prepare_meeting`은 upstream에 반영된 커밋만 수집하고 미푸시 로컬 커밋은 제외함
   - `DISCORD_BOT_TOKEN` (PM이 공유)
   - `DISCORD_USER_ID` (본인)
   - `DISCORD_SCRUM_CHANNEL_ID` (**포럼 채널** ID — 텍스트 채널 아님)
   - `DISCORD_TAG_IN_PROGRESS` / `DISCORD_TAG_COMPLETED` / `DISCORD_TAG_SUMMARY` (선택, 기본값 `진행`/`완료`/`정리`)
   - `NOTION_API_KEY`, `NOTION_PARENT_PAGE_ID`, `NOTION_LOCK_DB_ID` (PM/팀장만)
   - `JIRA_API_TOKEN`, `JIRA_EMAIL`, `JIRA_HOST`, `JIRA_PROJECT_KEY` (PM/팀장만)
   - `ALLOWED_USERS` (PM/팀장 Discord ID 목록, 콤마 구분)
5. MCP 서버 등록:

### Claude Code (v2.1+) — `claude mcp add` 명령 사용

> ⚠️ Claude Code v2.1+에서는 `settings.json`의 `mcpServers` 필드가 인식되지 않음.
> 반드시 아래 CLI 명령으로 등록해야 `~/.claude.json`에 올바르게 저장됨.

**Windows:**
```bash
claude mcp add team-mcp "C:/Program Files/nodejs/node.exe" "C:/절대경로/team-mcp/dist/server.js" --scope user
```

**macOS/Linux:**
```bash
claude mcp add team-mcp node /절대경로/team-mcp/dist/server.js --scope user
```

등록 확인:
```bash
claude mcp list
# 출력 예시: team-mcp: node /path/to/team-mcp/dist/server.js - ✓ Connected
```

> `.env` 파일이 team-mcp 디렉토리에 있으면 서버 시작 시 자동으로 로드됨.
> `--env KEY=VALUE` 플래그로 직접 넘길 수도 있지만, `.env` 방식을 권장.

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
   - Claude Code 완전히 종료 후 재시작
   - `/mcp` 명령으로 `team-mcp ✓ connected` 확인
   - `"진행 상황 보여줘"` 또는 `show_progress` 직접 호출 → 정상 응답이면 OK

7. **초기 프로젝트 세팅 (최초 1회)** — MCP 연결 확인 후 바로 진행:

   사용자에게 아래 두 가지를 순서대로 물어보고, 답변을 받은 뒤 `create_plan`을 호출해 플랜과 체크리스트를 생성한다.

   **질문 1 — 기획서**
   > "게임 기획서 내용을 알려주세요. 장르, 핵심 기능, 기술 스택, 마일스톤 등을 자유롭게 적어주시면 됩니다."

   **질문 2 — 내 파트**
   > "본인이 담당하는 파트(시스템·기능 목록)를 알려주세요. 예: GA_Attack 구현, 인벤토리 UI, 네트워크 동기화 등"

   두 답변을 받으면:
   ```
   create_plan({
     spec_content: "<질문1 답변>",
     my_part_content: "<질문2 답변>"
   })
   ```
   → 기획서.md + 내파트.md 저장 후 컨텍스트 수집 → AI가 분석 →
   ```
   create_plan({
     plan_markdown: "<분석 결과>",
     checklist_markdown: "<체크리스트>"
   })
   ```
   → 플랜.md + 체크리스트.md 생성 완료

   > 기획서.md / 내파트.md가 이미 게임 레포에 있으면 이 단계는 생략하고 `create_plan`을 바로 호출해도 됨.

8. **게임 레포에 AGENTS.md 복사 (최초 1회)**:

   team-mcp 레포의 `AGENTS.md`를 게임 레포 루트에 복사한다.
   ```bash
   copy C:\team-mcp\AGENTS.md C:\Users\...\GameProject\AGENTS.md
   ```
   이후 Claude Code · Codex가 게임 프로젝트에서 열릴 때 자동으로 읽어 툴 트리거 매핑이 동작한다.
   팀 규칙(코드 스타일·커밋 규칙 등)이 있으면 이 파일 앞에 합쳐서 사용한다.

## Discord 사전 준비 (PM 1회)

`finish_meeting`/`prepare_meeting`이 동작하려면 Discord에 다음을 미리 만든다:

1. **회의 포럼 채널** 1개 생성 (텍스트 채널 아님 — 채널 만들 때 "포럼" 유형 선택).
2. 포럼 채널의 **태그 설정**에서 다음 3개 태그를 정확히 이 이름으로 생성:
   - `진행` — prepare_meeting이 만든 회의 스레드에 자동 부착
   - `완료` — finish_meeting이 회의 종료 시 부착
   - `정리` — finish_meeting이 새로 만든 요약 스레드에 부착

   태그명을 바꾸려면 `.env`의 `DISCORD_TAG_IN_PROGRESS`/`DISCORD_TAG_COMPLETED`/`DISCORD_TAG_SUMMARY`를 설정.
3. 포럼 채널 ID를 `DISCORD_SCRUM_CHANNEL_ID`에 입력.
4. 봇에 다음 권한 부여: `채널 보기`, `메시지 보내기`, `스레드에서 메시지 보내기`, `메시지 기록 보기`, `메시지 관리`(태그 변경에 필요).

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
