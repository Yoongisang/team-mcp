# Team MCP Server

UE5 팀 프로젝트용 AI 협업 MCP 서버. Claude Code · Codex · Cursor 어디서든 동일하게 동작.

## 빠른 시작

```bash
git clone https://github.com/<your-org>/team-mcp
cd team-mcp
npm install
npm run build
cp .env.example .env   # 토큰 입력
```

## 도구 등록

각 도구에서 SETUP.md를 보고 자동 세팅:

- **Claude Code**: `claude` 실행 → `"SETUP.md 보고 등록해줘"`
- **Codex**: `codex` 실행 → `"SETUP.md 보고 등록해줘"`
- **Cursor**: `cursor` 실행 → `"SETUP.md 보고 등록해줘"`

수동 등록 예시는 SETUP.md 참고.

## 노출 툴

| 툴 | 설명 |
|---|---|
| `get_team_rules` | AGENTS.md 내용 반환 |
| `show_progress` | 체크리스트 진행률·지연 항목 |
| `create_plan` | 기획서 + 내파트 → 플랜 + 체크리스트 |
| `complete_task` | 항목 완료 처리 + 다음 작업 추천 |
| `change_direction` | 방향 변경 영향 분석 + 수정안 |
| `update_plan` | 플랜 직접 수정 |
| `prepare_meeting` | git log + 진행률 → Discord 스크럼 채널 |
| `finish_meeting` | Discord 수집 → 아카이브 → Notion + Jira (PM/팀장만) |

## 게임 레포와의 관계

- 본 레포는 **MCP 도구 코드**만 담음
- 게임 레포(`EternalDreams/`)는 별도. AGENTS.md / 기획서.md / 내파트.md / 플랜.md / 체크리스트.md 가 거기 위치
- `.env`의 `GAME_PROJECT_PATH`로 게임 레포를 가리킴

## 운영 모드

| 모드 | 트리거 위치 | 추가 세팅 |
|---|---|---|
| 수동 | 본인 터미널의 Claude Code/Codex/Cursor | 위의 빠른 시작·도구 등록만 |
| 자동 | Discord 채널 (예: "회의 완료" 한 줄) | PM 머신에 [Claude Code Channels](https://code.claude.com/docs/en/channels) Discord 플러그인 + 백그라운드 상시 세션. 자세한 절차는 SETUP.md `Channels 자동화 모드` 섹션 |

자동 모드에서도 본 MCP 서버 코드는 **수정 없이 그대로** 동작한다. Channels는 Discord 메시지를 Claude 세션에 푸시하기만 하고, 실제 작업은 동일하게 본 MCP 툴이 수행한다.
