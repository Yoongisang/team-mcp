# team-mcp AGENTS.md

이 파일은 Claude Code · Codex · Cursor가 **team-mcp 레포** 작업 시 자동으로 읽는 규칙 파일이다.
게임 프로젝트에서 MCP 툴을 사용할 때는 **게임 레포 루트의 AGENTS.md**를 읽는다 (이 파일의 복사본).

---

## 레포 개요

`team-mcp`는 UE5 팀 프로젝트용 MCP 서버다. 게임 레포와 분리된 독립 레포로,
Claude Code · Codex · Cursor 어디서든 동일하게 동작하는 8개 툴을 노출한다.

| 파일 | 역할 |
|---|---|
| `src/server.ts` | MCP 서버 진입점, 툴 레지스트리 |
| `src/config.ts` | .env 로드, lazy getter 패턴 |
| `src/tools/*.ts` | 툴 1개 = 1파일, zod 검증 + 핸들러 |
| `src/lib/*.ts` | Discord / Notion / Jira / Git / 파일 유틸 |

빌드: `npm run build` → `dist/`
테스트: `npx tsx src/smoke.ts`

---

## 자연어 → MCP 툴 매핑

다음 한국어 표현이 들어오면 지정된 team-mcp 툴을 호출한다.

| 입력 | 호출 |
|---|---|
| "초기 세팅" / "프로젝트 시작" / "플랜 처음부터" | 기획서·내파트 질문 후 `create_plan({ spec_content, my_part_content })` |
| "plan 만들어줘" / "플랜 짜줘" | `create_plan` (기획서.md·내파트.md 이미 있을 때) |
| "GA_X 완료" / "X 끝남" | `complete_task({ task_name: "X" })` |
| "방향 변경: ..." / "...로 전환" | `change_direction` |
| "회의 준비" / "스크럼" | `prepare_meeting({ user_name: 메시지 작성자 })` |
| "회의 완료" / "회의 마침" | `finish_meeting({ invoker_id: 메시지 작성자 Discord ID })` |
| "진행 상황" / "진척" | `show_progress` |
| "팀 규칙" / "AGENTS" | `get_team_rules` |

---

## 초기 세팅 온보딩 (최초 1회)

MCP 연결 확인 후 기획서와 내 파트가 게임 레포에 없으면 아래 순서로 진행한다:

1. 사용자에게 질문: "게임 기획서 내용을 알려주세요. 장르, 핵심 기능, 기술 스택, 마일스톤 등"
2. 사용자에게 질문: "담당 파트 목록을 알려주세요. 예: GA_Attack 구현, 인벤토리 UI 등"
3. 답변을 받으면 `create_plan({ spec_content: <1번>, my_part_content: <2번> })` 호출
4. 컨텍스트 수집 후 AI가 분석 → `create_plan({ plan_markdown, checklist_markdown })` 재호출
5. 플랜.md + 체크리스트.md 생성 완료

---

## Discord 메시지로 트리거된 호출의 인자 추출 규칙

Channels 플러그인을 통해 Discord 메시지가 컨텍스트로 들어온 경우:

- `prepare_meeting`의 `user_name`: 메시지 작성자의 Discord 표시 이름(또는 username) 그대로 사용.
  git `--author` 매칭에 쓰이므로 git 커밋 author 이름과 일치하는 게 이상적.
- `finish_meeting`의 `invoker_id`: 메시지 작성자의 Discord **user ID(snowflake, 긴 숫자)** 를 그대로 사용.
  절대 username을 넣지 말 것 (`ALLOWED_USERS`는 ID 기반 검증).
- 메시지 메타데이터에 ID가 명시적으로 보이지 않으면, 작업을 시도하지 말고 먼저 작성자 ID를 묻는다.

---

## 회의 흐름 (포럼 기반)

`DISCORD_SCRUM_CHANNEL_ID`는 **포럼 채널**을 가리킨다. 포럼에 `진행`, `완료`, `정리` 세 태그가 있어야 한다.

1. **prepare_meeting** → 포럼에 `[진행]` 태그 새 스레드 생성 (제목: `스크럼 회의 YYYY-MM-DD`)
2. 팀원들이 그 스레드의 **댓글**로 스크럼을 진행한다.
3. **finish_meeting** (인자 없이 1차) → 스레드 댓글 수집 → AI가 요약 분석
4. **finish_meeting** (summary + action_items로 2차) →
   - Notion 회의록 페이지 + Jira 이슈 생성 (액션 아이템별 개별 Task)
   - 원본 스레드 태그 `[진행]` → `[완료]`
   - 새 `[정리]` 태그 요약 스레드 생성 (Notion·Jira 링크 포함)

---

## 안전 가이드

- `finish_meeting`은 비가역 작업(태그 변경, Notion·Jira 작성)을 포함한다.
  Discord 메시지로 트리거된 경우라도 결과를 채널에 회신해 사용자가 확인할 수 있게 한다.
- 원본 댓글은 **삭제하지 않는다** — `[완료]` 태그로 보존된다.
- 락 충돌(`다른 처리 진행 중`) 에러를 받으면 자동 재시도하지 말고 채널에 그대로 알려준다.
- `ALLOWED_USERS`에 없는 사용자가 `finish_meeting`을 시도하면 `권한 없음` 에러가 난다. PM에게 안내하라.
- 포럼에 `진행`/`완료`/`정리` 태그가 없으면 명확한 에러로 멈춘다 — 포럼 설정에서 태그를 만들어야 한다.

---

## 코드 수정 규칙 (team-mcp 레포 작업 시)

- 새 툴 추가 시: `src/tools/새툴.ts` 생성 → `src/server.ts`의 핸들러 맵에 등록
- 환경변수 추가 시: `src/config.ts` lazy getter 추가 + `.env.example` 업데이트 + `SETUP.md` 반영
- 외부 API 변경 시: `src/lib/` 해당 파일만 수정 (툴 파일은 건드리지 않음)
- 빌드 후 반드시 `npm run build` 통과 확인
- `.env`는 절대 커밋하지 않음
