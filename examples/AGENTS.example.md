# 팀 규칙 예시 (게임 레포의 AGENTS.md 템플릿)

이 파일은 본 team-mcp의 운영을 안정화하기 위해 **게임 레포의 `AGENTS.md`**에 추가 권장하는 섹션을 모은 예시다. 각 팀의 규칙(코드 스타일·커밋 규칙 등)에 아래 섹션을 합쳐 사용한다.

---

## 자연어 → MCP 툴 매핑

다음 한국어 표현이 들어오면 지정된 team-mcp 툴을 호출한다.

| 입력 | 호출 |
|---|---|
| "plan 만들어줘" / "플랜 짜줘" | `create_plan` |
| "GA_X 완료" / "X 끝남" | `complete_task({ task_name: "X" })` |
| "방향 변경: ..." / "...로 전환" | `change_direction` |
| "회의 준비" / "스크럼" | `prepare_meeting({ user_name: 메시지 작성자 })` |
| "회의 완료" / "회의 마침" | `finish_meeting({ invoker_id: 메시지 작성자 Discord ID })` |
| "진행 상황" / "진척" | `show_progress` |

## Discord 메시지로 트리거된 호출의 인자 추출 규칙

Channels 플러그인을 통해 Discord 채널 메시지가 컨텍스트로 들어온 경우:

- `prepare_meeting`의 `user_name`: 메시지 작성자의 Discord 표시 이름(또는 username) 그대로 사용. git `--author` 매칭에 쓰이므로 git 커밋 author 이름과 일치하는 게 이상적.
- `finish_meeting`의 `invoker_id`: 메시지 작성자의 Discord **user ID(snowflake, 긴 숫자)** 를 그대로 사용. 절대 username을 넣지 말 것 (`ALLOWED_USERS`는 ID 기반 검증).
- 메시지 메타데이터에 ID가 명시적으로 보이지 않으면, 작업을 시도하지 말고 먼저 작성자 ID를 묻는다.

## finish_meeting 두-단계 패턴

`finish_meeting`은 인자 없이 호출하면 Discord 스크럼 채널의 메시지를 컨텍스트로 반환한다. AI는 이 컨텍스트를 분석해 `summary`와 `action_items` 배열을 작성한 뒤, 동일 툴을 다시 호출해 작성·아카이브를 트리거한다. 첫 호출은 락을 잡지 않으므로 안전하게 컨텍스트만 가져온다.

## 안전 가이드

- `finish_meeting`은 운영상 비가역 작업(원본 메시지 삭제, Notion·Jira 작성)을 포함한다. Discord 메시지로 트리거된 경우라도 결과를 채널에 회신해 사용자가 확인할 수 있게 한다.
- 락 충돌(`다른 처리 진행 중`) 에러를 받으면 자동 재시도하지 말고 채널에 그대로 알려준다.
- `ALLOWED_USERS`에 없는 사용자가 `finish_meeting`을 시도하면 `권한 없음` 에러가 난다. 이 경우 PM에게 안내하라.
