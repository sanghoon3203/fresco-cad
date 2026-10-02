# Fresco Studio UX — Apple 스타일 재설계와 AI 편집 루프 연결

2026-10-02. 구현: `addons/jw-assistant/ui/studio.{html,css,mjs}`, `ui/studio-canvas.mjs`, `ui/motion.mjs`, `ui/studio/{i18n,toast,sheet,ops}.mjs`, 서버 `tools/studio-server.mjs`(`/api/v2/*`). 테스트: `tests/studio-motion.test.mjs`, `tests/studio-v2.test.mjs`(기존 `studio-smoke`/`studio-workflow`도 유지). npm 의존성·CDN 없음(오프라인 사무소 사용).

실행: `node tools/studio-server.mjs 4318 C:/JWW` → `http://127.0.0.1:4318/ui/studio.html`. 기존 리뷰 화면(`ui/index.html`)과 v1 엔드포인트(`/api/open`, `/api/skill-preview` …)는 그대로 동작한다.

## 1. 적용한 디자인 원칙과 출처

주 참고: Emil Kowalski의 스킬(MIT) — `apple-design`(핵심), `emil-design-eng`, `animate`(+`RECIPES.md`), `review-animations/STANDARDS.md`, `ask-sonner`. 텍스트·코드는 복사하지 않고 원칙만 적용했다.

| 원칙 | Studio에서의 적용 |
|---|---|
| 반응은 pointer-down에서 | 모든 버튼 `:active { scale(.97) }` 160ms ease-out. 캔버스는 누르는 순간 관성·카메라 스프링을 멈추고 커서를 grabbing으로 |
| 1:1 직접 조작 | 팬은 포인터와 1:1(pointer capture), 트랙패드 스크롤도 1:1. 핀치(터치 2점·`ctrlKey` 휠) 줌은 두 손가락 중점 고정 |
| 중단 가능성·표시값에서 시작 | `motion.mjs`의 모든 애니메이션은 현재 표시값+속도에서 시작, 진행 중 재타깃 시 속도 보존. 카메라는 cx/cy/log-zoom 축별 스프링 |
| 속도 인계·모멘텀 투영 | 팬 해제 속도 → 지수 감쇠 관성(`d=0.998`, `project(v)=v/1000·d/(1−d)`과 같은 식). 경계에 닿으면 남은 속도를 스프링에 넘겨 부드럽게 되돌아옴 |
| 러버밴딩 | 중심 이동 한계(도면 bbox + 화면 45%)와 줌 한계에서 `rubberband()` 저항, 손을 떼면 임계감쇠 스프링으로 복귀 |
| 공간 일관성 | 설정/단축키/생성 팝오버는 트리거 버튼 위치를 `transform-origin`으로 삼아 나오고 같은 길로 들어감. 변경안 시트는 명령바에서 위로 자라남 |
| 키보드 작업은 애니메이션 없음 | ⌘K는 포커스만(무애니메이션), 키보드로 연 시트는 즉시 표시 |
| 재질·깊이 | 사이드바(무거운 재질)·인스펙터·명령바는 `backdrop-filter` 반투명 + 다층 그림자, 도면은 그 아래 풀블리드. 다른 반투명 패널 위에 뜨는 팝오버·토스트·변경안은 거의 불투명(`--mat-pop`) — 유리 위 유리 금지 |
| 타이포 | 시스템 폰트(`-apple-system, SF Pro, Hiragino Sans, Yu Gothic UI …`), 큰 제목 음수 트래킹(−.022em), 작은 라벨 양수(+.04em 대문자), 8pt 그리드, 일본어는 `word-break: auto-phrase` |
| 절제 | 액센트 1색(파랑) + 의미색(추가=초록, 삭제=빨강, 경고=호박)만. 바운스는 모멘텀이 있었던 곳(토스트 플릭, 체크 표시)에만 |
| 피드백 1회·원인 프레임 | 변경안 도착=그 프레임에 diff 모션 시작, 실패=명령바 1회 넛지(−900px/s 스프링), 저장=토스트 + 제목 칩 펄스 |

추가 참고(사용자 공유, 웹 컴포넌트 라이브러리 — 코드 미사용, 아이디어만):

| 출처 | 라이선스 | 가져온 아이디어 |
|---|---|---|
| coss ui (coss.com/ui) | AGPLv3 → 코드 미참조 | Input Group 안의 `Kbd`(명령바의 ⌘K/Ctrl K), Empty 컴포넌트 구성(아이콘·제목·설명·행동 버튼 2개) → 빈 상태, Segmented Control(도구·탭·테마), 쌓이는 Toast |
| ObsidianUI (MIT) | MIT | "Apple Spotlight" 류 강조 → 명령바 포커스 링/작업 중 테두리 스윕, 텍스트 리빌 계열 → 작업 상태 텍스트 shimmer(순수 CSS) |
| Originkit | 상용/Framer 중심 | 텍스트 shimmer·애니메이션 버튼은 참고만. 배경/파티클 효과는 절제 원칙상 채택하지 않음 |
| Componentry | 명시 없음(OSS 표방) | Magnetic Dock 등 장식 효과는 CAD 업무 빈도에 맞지 않아 미채택. 컴포넌트 카탈로그 구성만 참고 |
| "beautiful UI" | 특정 불가 | 같은 이름의 라이브러리를 특정하지 못함(Tailwind 계열 다수). 반영 없음 |

## 2. 화면 구성

- **타이틀바**(반투명): 사이드바 토글, 앱명/문서명/“保存済みコピー” 칩, 가운데 도구(선택 V / 팬 H), 줌 −/표시(원寸=100%)/+, 전체 맞춤, 오른쪽 平面図を生成(generator가 있을 때만), 리뷰 화면 링크, 단축키, 설정, 인스펙터 토글.
- **사이드바**: 도면 목록(원본 / 작업 파일, 검색, 자동저장 `.jw$` 숨김) + 레이어(그룹별, 이름·역할(이름→사무소 프로필→사내 규칙 순), 개수, 레이어 체크 배지, 표시 토글(Alt+클릭 단독), 파일의 비표시 레이어는 처음에 숨김).
- **캔버스**: 풀블리드. 인쇄와 같은 펜 폭(`office-drafting-rules.json`의 `printWidth_hundredthMm`, 화면 최소 0.75px), 화면색 `screenRgb`(다크 테마에서 어두운 펜은 명도 보정), Jw 선종 대시 패턴(용지 mm), 블록·원호·문자·솔리드 포함(`native/render/flatten.mjs`를 서버에서 실행 → 용지 mm 프리미티브).
- **인스펙터**: 탭 2개 — 選択(모델 mm 좌표·레이어·선색 스와치·文字/高さ 편집, 이동량, 삭제), レイヤチェック(`checkLayers` 결과, 클릭 시 해당 요소 선택+맞춤).
- **명령바**(항상 하단, ⌘K/Ctrl+K): 공급자 필(자동/데모(모크)/Claude/Claude 고속/OpenAI, 키 없는 항목은 “キー未設定”), 선택 개수 칩, 입력, 작업 상태(경과 초), 전송.
- **변경안 시트**(명령바에 앵커): 상태 아이콘, 시도 n/최대, 공급자/모델, 비용 추정(모크는 “費用なし”), 지연시간, rationale, op 칩(移動/削除/追加/変更/レイヤ変更/線属性), diff 범례+“動きを再生”, 레이어 경고 + “推奨レイヤを適用”, 破棄 / 新しいJWWとして保存. 확인 질문이면 같은 자리에서 답 입력 → 재실행. 실패면 오류 설명·시도 목록·재시도, 키 미설정이면 “デモで試す”.
- **API 키 미설정 상태**: 명령바 위 안내 띠(닫기 가능) + 설정 시트의 키 상태(ANTHROPIC_API_KEY / OPENAI_API_KEY 미설정). 키는 화면에서 입력하지 않는다(환경 변수 + 재시작). 자동 모드는 키가 없으면 모크로 동작.

## 3. 서버 엔드포인트 (`/api/v2/*`, 127.0.0.1 전용)

공통: Host/Origin 검사, POST는 `X-Fresco-Token` 필수, 본문 100KB(patch/generate 512KB), 파일은 서버가 만든 ID로만 접근(기존 drawingRoot + workRoot만), 원본은 절대 쓰지 않음.

| 메서드 | 경로 | 내용 |
|---|---|---|
| GET | `bootstrap` | token, 파일 목록(원본/작업, 크기·mtime), AI 설정·키 상태, generator 유무, 펜 표 |
| GET | `files` | 파일 목록 갱신 |
| POST | `open` `{fileId}` | 코덱 디코드 → 장면(용지 mm 프리미티브 + 레이어 + 레이어 체크). 복사본을 만들지 않음. DLL 판독(IR)은 백그라운드 예열 |
| GET | `scene?session` / `entity?session&id` | 장면 / 인스펙터용 모델 mm 상세 |
| POST | `edit` `{sessionId, baseHash, instruction, selection[], provider}` | `runEdit`(키 없으면 모크) → 상태(applied/clarification/failed), 시도·사용량·비용, op, `diffScenes` 결과, `checkPatchLayers` 결과 |
| POST | `patch` `{patch}` | 인스펙터 수동 Patch v2 → `applyPatchV2` → 같은 미리보기 |
| POST | `fix-layers` `{previewId}` | 미리보기의 레이어 교정(`applyLayerCorrections`) 후 재적용 |
| POST | `accept` `{previewId}` | 미리보기 바이트를 `workRoot/<이름>-edit-NN-xxxxxx.jww`로 `wx`+fsync 저장, 세션 이력 push |
| POST | `reject` / `undo` / `close` | 미리보기 폐기 / 이전 상태로(저장 파일은 남김) / 세션 종료 |
| GET/POST | `settings` | `dataPolicy.sendRealDrawings`, `redactText`, 기본 공급자만 변경 가능(`ai/settings.mjs` `saveSettings`, 비밀 필드는 저장 안 됨) |
| GET/POST | `generator` / `generate {spec}` | `generator/draw-plan.mjs`가 있을 때만: 예시 spec / 생성→작업 폴더 저장→열기, `E_SPEC` 상세 반환 |

정적 자산 `ui/motion.mjs`, `ui/studio/*.mjs`는 화이트리스트로 같은 CSP를 붙여 제공한다(`tools/serve.mjs`는 수정하지 않음).

## 4. 인터랙션 목록과 스프링 값 (`damping` 비, `response` 초)

| 인터랙션 | 방식 | 값 |
|---|---|---|
| 버튼 누름 | CSS `:active scale(.97)` | 160ms `cubic-bezier(.23,1,.32,1)` |
| 전체/선택 맞춤(F, Shift+F, 더블클릭) | 카메라 3축 스프링 | 1.0 / 0.5 |
| 마우스 휠 줌(노치) | log-zoom 스프링, 커서 고정 앵커 | 1.0 / 0.28, 노치당 ×1.25 |
| 트랙패드 핀치·스크롤 | 1:1 즉시, 160ms 후 한계 정착 | 줌 한계 rubberband(c=0.3) |
| 팬 해제 | 지수 감쇠 관성 | d=0.998 /ms, 8px/s 미만 정지 |
| 경계 복귀 | 속도 인계 스프링 | 1.0 / 0.45 |
| 화살표 팬 | 스프링 | 1.0 / 0.4 (`SPRINGS.move`) |
| 선택 헤일로 | 폭 10→6px·알파 0→.22 1회 | 1.0 / 0.32 |
| diff 재생 | 추가 도형이 이동 전 위치에서 미끄러져 들어감 + 그라데이션 궤적·화살표, 고스트 점선 페이드 | 1.0 / 0.55 |
| 변경안 시트 | y 14→0, scale .97→1, opacity | 0.86 / 0.32 (`SPRINGS.sheet`) |
| 팝오버/메뉴 | 트리거 원점 scale .94→1 | 열기 0.86/0.32, 닫기 1.0/0.22 |
| 사이드바/인스펙터 토글 | translateX(같은 방향으로 들어가고 나감) | 0.86 / 0.32 |
| 레이어 체크 표시 | 체크 scale .4→1, 박스 .86→1 | 0.62 / 0.28 (`SPRINGS.check`) |
| 스위치 노브 | x 0↔16 | 0.8 / 0.35 (`SPRINGS.flick`) |
| 토스트 | 스택(뒤쪽 scale −5%/단, 10px 엿보기), hover 펼침, 위로 스와이프(−40px 또는 −110px/s) | 등장 1.0/0.35, 되돌림 0.8/0.35(속도 인계) |
| 실패 넛지 | 명령바 x 속도 −900px/s 스프링 1회 | 0.8 / 0.35 |
| 목록 진입 | 30ms 이하 간격 stagger(최대 14행, 최초 1회) | 320ms ease-out |
| AI 작업 중 | 명령바 테두리 그라데이션 스윕 + 상태 텍스트 shimmer | 1.4s / 1.8s linear |

`motion.mjs` API: `springAt()`(폐형해: 저/임계/과감쇠), `Spring`(setTarget이 속도 보존), `animate(el|obj, props, {damping, response, velocity, immediate, onUpdate})` → `{finished, stop, retarget, springs}`, 같은 속성 재호출 시 기존 스프링 재타깃, `project()`, `rubberband()`, `rubberClamp()`, `VelocityTracker`, `frameLoop()`. rAF 클록 + 100ms 워치독(창이 그리지 않을 때도 상태가 수렴).

## 5. 단축키

⌘K/Ctrl+K 명령바 · F 전체 · Shift+F/더블클릭 선택 확대 · +/− 줌 · 화살표 팬(Shift=크게) · Space+드래그/가운데·오른쪽 버튼 팬 · V/H 도구 · 클릭 선택, Shift/⌘ 클릭 추가·토글 · 드래그 범위선택(왼→오: 완전 포함, 오→왼: 교차, 점선) · Esc 시트 닫기→변경안 破棄→선택 해제 · ⌘↵/Ctrl+Enter 저장 · ⌘Z/Ctrl+Z 되돌리기 · ? 단축키 목록.

## 6. 접근성

- 전 기능 키보드 접근, `:focus-visible` 3px 링(고대비에서 실선), 탭은 화살표 이동, 메뉴는 ↑↓, 레이어 토글은 `role=checkbox`, 스위치는 `role=switch`, 선택 개수는 라이브 영역으로 알림, 캔버스는 `role=application` + 조작 설명.
- `prefers-reduced-motion` 또는 앱 설정 “動きを減らす”(리뷰 화면과 같은 저장 키 `fresco-jw-assistant-reduce-motion`): 위치·스케일 애니메이션 제거, 크로스페이드만, 관성·헤일로·diff 슬라이드 생략, 스윕 대신 정적 테두리.
- `prefers-reduced-transparency`: blur 제거, 불투명 재질. `prefers-contrast: more`: 진한 구분선·텍스트, 패널 실선 테두리. `forced-colors` 체크 표시 대응.
- CSP(`style-src 'self'`) 하에서 인라인 스타일 없이 CSSOM으로만 변형.

## 7. 검증

- 단위: `tests/studio-motion.test.mjs`(정착, 임계감쇠 무오버슈트·단조, 수치적분 일치, 재타깃 연속성, 속도 인계, project/rubberband, VelocityTracker, animate 재타깃·reduced motion), `tests/studio-v2.test.mjs`(모크 스크립트 일·한·영, diff, op 설명, 가드·설정·키 미설정, 실제 JWW로 open→모크 edit→diff→accept 새 파일→수동 patch→undo).
- 브라우저(인앱, 1440×900): 木造平面例 열기 → 클릭/교차 범위 선택 → “この窓を910右へ”(모크) → diff → 保存 → Ctrl+Enter/Ctrl+Z, “거실 창문 넓혀줘” 확인 질문, 영어 UI + Claude 선택 시 키 미설정 시트, 다크 테마 21,209요소 도면(腹部研修).
- 성능(腹部研修 21,209요소): open 0.5s(코덱+flatten+레이어 체크), 기본 렌더 패스 약 1ms(387 배치, 타일 컬링). 모크 편집은 DLL 판독/검증 때문에 큰 도면에서 수십 초(아래 한계).

스크린샷(`outputs/studio-ux/`, 미추적): `01-empty-light.jpg`, `02-crossing-selection.jpg`, `03-clarification-ko.jpg`, `04-dark-21k-entities.jpg`, `05-settings-dark.jpg`, `06-proposal-diff.jpg`, `07-accepted-toast-undo.jpg`, `08-key-not-set-en.jpg`.

## 8. 한계·후속

- 편집 적용/검증은 `applyPatchV2`가 DLL 판독(`readJww`)과 `toIR`을 쓰므로 큰 도면에서 느리다(21k요소 모크 편집 ≈ 30–70s). 열 때 백그라운드 예열을 하지만 결과 재판독은 남는다. 코덱 기반 검증 경로가 생기면 크게 줄어든다.
- 실제 Claude/OpenAI 호출은 키가 없어 UI에서 검증하지 못했다(모크·키 미설정 경로만). AI 진행 상황은 스트리밍이 아니라 경과 시간만 표시한다.
- 사용자 판정(`recordFeedback`)은 아직 UI에 연결하지 않았다(accept/reject 시 기록하면 학습 루프에 도움).
- HUD 좌표는 주 그룹 축척 기준 근사(인스펙터 값은 정확). 문자 폭·간격은 근사, 이미지 미표시.
- diff 대응은 기하 서명 기반이라 같은 모양의 요소가 여러 개면 이동 궤적 짝짓기가 바뀔 수 있다(결과 자체는 정확).
- 레이어 그룹 표시 상태, 블록 내부 요소의 개별 선택/편집, 다중 실행 취소 이력 UI는 없다.
