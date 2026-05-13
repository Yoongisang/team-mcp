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
| `prepare_meeting` | git log + 진행률 → Discord 스크럼 채널. 커밋↔체크리스트 자동 매칭 (high: 즉시 체크 / partial: 사용자 확인 / none: 체크리스트에 새 항목으로 추가 + 체크) |
| `finish_meeting` | Discord 수집 → 아카이브 → Notion 회의록 (PM/팀장만). 기본은 Jira 신규 생성 안 함 |
| `apply_meeting_to_backlog` | 회의 내용 분석 → 기존 Jira 백로그/스프린트 작업에 변경 적용 (PM/팀장만, Discord ✅ 승인) |

### 회의 → 백로그 반영 흐름

이미 Jira 백로그가 구축된 환경에서는 회의에서 나온 변경사항을 **새 이슈로 만들지 않고 기존 이슈를 업데이트**한다.

```
prepare_meeting → (회의 진행) → finish_meeting
                                     ↓
                          apply_meeting_to_backlog (Phase 1: 컨텍스트 fetch)
                                     ↓
                          [LLM이 회의 분석 → proposals JSON 생성]
                                     ↓
                          apply_meeting_to_backlog (Phase 2: proposals 전달)
                                     ↓
                          → Discord 정리 스레드에 미리보기 + ✅ reaction 대기
                                     ↓
                          [PM/팀장이 Discord에서 ✅ 클릭]
                                     ↓
                          apply_meeting_to_backlog (Phase 3: confirm: true)
                                     ↓
                          → 일괄 적용 (담당자/기한/스프린트/코멘트/재오픈)
```

지원 액션:
- `assign` — 담당자 변경 (표시명 → accountId 자동 조회)
- `schedule` — 시작일/마감일 변경
- `move_to_sprint` — 스프린트 이동
- `comment_only` — 진행 노트만 추가
- `reopen` — 완료 상태를 진행 중으로 되돌리기 + 회의 코멘트

레거시 동작(액션 아이템마다 신규 Jira Task 생성)이 필요하면 `finish_meeting` 호출 시 `create_action_issues: true` 인자 전달.

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
