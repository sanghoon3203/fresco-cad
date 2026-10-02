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
- 실제 Claude/OpenAI 호출은 키가 없어 UI에서 검증하지 못했다(모크·키 미설정 경로만). ~~AI 진행 상황은 스트리밍이 아니라 경과 시간만 표시한다.~~ → 2차에서 스트리밍 타임라인으로 해결(§9).
- 사용자 판정(`recordFeedback`)은 아직 UI에 연결하지 않았다(accept/reject 시 기록하면 학습 루프에 도움).
- HUD 좌표는 주 그룹 축척 기준 근사(인스펙터 값은 정확). 문자 폭·간격은 근사, 이미지 미표시.
- diff 대응은 기하 서명 기반이라 같은 모양의 요소가 여러 개면 이동 궤적 짝짓기가 바뀔 수 있다(결과 자체는 정확).
- 레이어 그룹 표시 상태, 블록 내부 요소의 개별 선택/편집은 없다. ~~다중 실행 취소 이력 UI는 없다.~~ → 2차에서 이력 스크러버 추가(§9).

## 9. 2차(Wave 2) — 물리적으로 올바른 인터랙션 컴포넌트

2026-10-02. 새 모듈: `ui/studio/{progress,morph,dragmove,scrub,odometer,minimap,history,menu,tooltip,pill,strings2}.mjs`, `ui/motion.mjs`에 순수 함수 `detent / nearestStep / magneticSnap / projectSnap / scrubRate / scrubValue` 추가, `ui/studio-canvas.mjs`에 선택 드래그·비교 레이어·`batchScene()` 공용화. 서버는 `POST /api/v2/edit-stream`(별도 핸들러, 기존 `/edit`·`/accept`는 손대지 않음)과 자산 화이트리스트만 추가했다.

### 9.1 감사(audit) — find-animation-opportunities / improve-animations 방법론

방법: 1차 Studio의 모든 화면을 빈도(100+/일, 수십/일, 가끔, 드묾) → 목적(피드백/공간 일관성/상태 표시/급변 방지/설명/즐거움) → 시간 예산(UI 300ms 이내) → 기능(정보 밀도가 높은 도면 위 장식 금지) 4단계 관문으로 걸렀다. 기존 애니메이션은 8개 감사 범주(목적·이징·물리성·중단 가능성·성능·접근성·일관성·누락)로 점검했다.

**기존 구현 점검 결과**

| 범주 | 발견 | 조치 |
|---|---|---|
| 목적·빈도 | ⌘K·V/H·화살표 팬 등 키보드 동작은 이미 무애니메이션(정상) | 유지. 새 컴포넌트도 키보드로 연 경우 즉시 표시(메뉴·탭 필·도구 필) |
| 누락: 급변 | AI 작업 중 “경과 초”만 보이고 무엇을 하는지 모름, 결과가 갑자기 나타남 | 실시간 진행 타임라인(§9.2-1) |
| 누락: 공간 일관성 | 변경안 시트가 명령바 위에 별도 표면으로 뜸(같은 의도의 연속인데 표면이 끊김) | 명령바 → 카드 공유 요소 모프(§9.2-2) |
| 누락: 직접 조작 | 이동은 인스펙터에 숫자 입력만 가능 | 캔버스 드래그 + 455/910 자석 스냅(§9.2-3) |
| 물리성 | 레이어 체크/토스트는 스프링, 세그먼트·탭 선택은 배경이 즉시 바뀜(텔레포트) | 슬라이딩 필(§9.2-7) |
| 중단 가능성 | 대부분 스프링(재타깃 시 속도 보존). 목록 진입 stagger만 keyframe(최초 1회라 허용) | 유지 |
| 성능 | 캔버스는 dirty 시에만 다시 그림, DOM은 transform/opacity만 | 새 요소도 동일 규칙(이력 비교는 캔버스 opacity만, 미니맵 사각형은 184×124 캔버스) |
| 접근성 | reduced motion/transparency/contrast 대응 완비 | 새 요소 모두 동일 폴백 추가 |

**채택한 기회(우선순위순)**

| # | 위치 | 이전 | 목적 | 빈도 | 모션 |
|---|---|---|---|---|---|
| 1 | 명령바 작업 중 | 경과 초만 | 상태 표시·급변 방지 | 가끔(편집마다) | 단계가 순서대로 미끄러져 들어옴(0.9/0.3), 상태 아이콘 체크 1회 팝(0.62/0.28) |
| 2 | 명령바↔변경안 | 별도 시트 | 공간 일관성 | 가끔 | 같은 표면이 위로 자라고 같은 길로 접힘(0.88/0.34, 접힘 1.0/0.26) |
| 3 | 캔버스 선택 요소 | 숫자 입력만 | 직접 조작·피드백 | 수십/일 | 1:1 추적, 디텐트 스냅, 놓으면 속도 인계 스프링(0.86/0.28) |
| 4 | 이력 | 없음 | 상태 표시·설명 | 가끔 | 스크럽 1:1 크로스페이드, 플릭 투영 후 노드 스냅(0.82/0.3) |
| 5 | 세그먼트/탭 | 즉시 전환 | 상태 표시 | 수십/일 | 하나의 필이 이동(0.9/0.3) — 키보드 시 즉시 |
| 6 | 미니맵 | 없음 | 공간 일관성(현재 위치) | 가끔(확대 시에만 표시) | 카메라 추적 스프링(1.0/0.12), 드래그 1:1, 플릭 투영 |
| 7 | 숫자 라벨 스크럽·오도미터·메뉴·툴팁·스켈레톤·포커스·저장 정착 | 각각 없음 | 피드백·급변 방지 | 다양 | 아래 표 |

**기각한 후보**

- 줌 퍼센트 표시(`zoom-readout`)의 오도미터 — 휠/핀치마다 수십 번 바뀌는 고빈도 값. **빈도 관문에서 기각**(읽는 숫자를 굴리면 방해).
- 선택 개수 칩의 숫자 롤 — 클릭마다 바뀜(수십/일). **빈도 관문에서 기각**.
- 레이어 행 hover 시 확대/자석 효과(Componentry Magnetic Dock 류) — 업무용 목록에서 장식. **기능 관문에서 기각**.
- 도면 위 diff 외의 장식(입자·그라데이션 배경, Originkit 류) — 사용자가 읽는 데이터 위의 장식. **기능 관문에서 기각**.
- 레이어 “실제 재정렬”(드래그로 순서 바꾸기) — JWW 레이어 번호(0–F)는 고정이라 데이터상 의미가 없음. 대신 **정렬 전환(ID순/요소 수순) + FLIP 이동**으로 같은 마이크로 인터랙션을 의미 있게 제공.
- 키보드로 여는 컨텍스트 메뉴/탭 전환의 애니메이션 — 키보드 동작은 애니메이션하지 않는다(즉시).

**판정**: 1차 Studio는 이미 절제가 잘 되어 있었고, 부족한 것은 “장식”이 아니라 **인과를 보여 주는 모션**(AI가 무엇을 하는지, 카드가 어디서 왔는지, 무엇이 어디로 움직이는지)과 **직접 조작**이었다. 가장 레버리지가 큰 것은 1(진행 타임라인)과 3(캔버스 드래그).

### 9.2 컴포넌트 (목적 · 스프링 `damping/response` · reduced motion)

| # | 컴포넌트 | 목적 | 값 | reduced motion |
|---|---|---|---|---|
| 1 | **실시간 AI 진행 타임라인** (`progress.mjs`, 서버 `edit-stream`) | 실제 단계 표시: 図面を読み込み → 対象を検索(도구 호출 이름·인자 요약) → 変更案を作成(op 수·종류) → 検証 L1(형식·레이어) → 検証 L2(쓰기·재판독) → 完了/中止. 재시도는 그 단계에 검증 오류 코드·설명·detail을 인라인(호박색 “再試行 — 試行 n”) | 행 진입 y 8→0 + opacity(0.9/0.3), 상태 전환 시 아이콘 0.5→1(0.62/0.28). 이벤트 사이 45ms 간격(30–80ms stagger 범위, 즉답하는 모크도 순서가 읽힘; 느린 단계는 실제 시간만큼 “실행 중”) | 위치 이동 없이 opacity만, 간격 0, 스피너 → 펄스 |
| 2 | **공유 요소 모프** (`morph.mjs`) | 명령바가 카드로 자라고(작업 중 타임라인 → 변경안으로 내용 교체 시 높이도 같은 스프링으로 재타깃), 저장/破棄 시 같은 길로 접힘 | 보이는 높이 v 하나의 스프링: 열림 0.88/0.34, 크기 변경 1.0/0.3, 접힘 1.0/0.26. `clip-path: inset(top … round 18px)`로 드러내므로 글자·모서리 왜곡 없음, 그림자는 별도 판을 `scaleY`(transform). 내용은 표면이 28% 자란 뒤 페이드 인, 접을 때는 먼저 페이드 아웃. 실패 시 독 전체 1회 넛지(−900px/s, 0.8/0.35) | 성장 없이 크로스페이드(0.18) |
| 3 | **캔버스 직접 조작** (`dragmove.mjs`, `studio-canvas.mjs`) | 이미 선택된 요소를 누르고 끌면 이동. 잡은 오프셋 유지(1:1), 잡은 점 근처 꼭짓점을 기준점으로 사용. **455 모듈(910=주 모듈) 스냅은 이동량(모델 mm)에**, 다른 요소의 **끝점 스냅은 2D**로 우선. Alt=자유. 스냅 표시: 모듈 가이드선(910은 진하게), 끝점 링 + 잠길 때 “딸깍” 펄스. 커서를 따라가는 Δx/Δy(모델 mm) 칩(스프링 없음, 제스처의 일부). 놓으면 잠긴 스냅 목표(또는 1mm 반올림 위치)로 **놓는 속도를 인계**한 스프링 후 Patch v2 `translate` → 기존 `/patch` 미리보기 → 카드 → 保存. Esc=제자리로 스프링 복귀 | 디텐트 `d·(|d|/r)²`(r=10px): 경계에서 연속·단조·중심에서 정확히 목표. 펄스 1.8→1(0.6/0.22). 놓기 0.86/0.28. 시작 시 원본은 기본 레이어에서 빼고(1회 재배치) 점선 고스트로 표시. 같은 축척의 레이어만(혼합 시 드래그 불가). 시작 지점 바로 옆 끝점(이중 벽선 반대 면 등)은 3R 이상 끌기 전엔 스냅 후보에서 제외(첫 픽셀이 옆으로 튀지 않게) | 놓으면 즉시 목표 위치, 펄스 없음 |
| 4 | **숫자 스크럽 필드** (`scrub.mjs`) | 인스펙터 X/Y 라벨, 半径·文字高さ 라벨을 좌우로 끌면 값 변경(1px=1mm, Shift ×10, Alt ×0.1; 수정키를 도중에 바꾸면 현재 값에서 재기준 → 점프 없음). 한계 밖은 러버밴드, 놓으면 한계로 스프링(속도 인계). 스크럽은 커밋하지 않고 입력칸에 “대기” 표시 + 포커스 → Enter로 변경안(큰 도면이 픽셀마다 재계산하지 않게) | 러버밴드 `rubberband(px, 160)`, 복귀 1.0/0.32 | 복귀 즉시 |
| 4b | **오도미터** (`odometer.mjs`) | “다른 곳에서” 바뀐 읽기 전용 숫자(인스펙터의 要素·使用レイヤ 수, 선 길이)가 저장/삭제 후 자리별로 굴러감. 증가=위로, 9→0은 앞으로 감김, 아래 자리일수록 늦게 정착 | 자리별 1.0/(0.42→0.54) | 숫자 즉시 교체 |
| 5 | **이력 타임라인/실행 취소 스크러버** (`history.mjs`) | 저장한 편집마다 노드(0=연 시점). hover → 썸네일(그 편집 위치를 파란 사각형으로), 따뜻한 이웃은 즉시. 플레이헤드를 끌면 이웃 두 상태를 캔버스에서 1:1 크로스페이드(노드에 소프트 디텐트), 놓으면 플릭을 투영해 가장 가까운 노드로 스냅하고 그 상태를 미리보기 + “この時点に戻す”. 노드 클릭/버튼 = 그 지점까지 undo(저장 파일은 남음). Esc·현재 노드 = 미리보기 종료. ←/→ 키 이동(즉시) | 플레이헤드 0.82/0.3(속도 인계), 썸네일 0.96→1(1.0/0.2), 비교 레이어는 카메라 변경 시에만 다시 그림 — 스크럽 프레임은 opacity만 | 크로스페이드는 유지(이해를 돕는 opacity), 위치 스프링 즉시 |
| 6 | **미니맵** (`minimap.mjs`) | 화면이 도면 전체를 보여 주지 못할 때(맞춤 줌의 1.2배 이상)만 나타남. 뷰포트 사각형은 카메라를 스프링으로 추적, 사각형을 잡아 끌면 1:1(잡은 오프셋 유지), 바깥 클릭은 그 지점으로 카메라 스프링, 플릭은 `projectSnap`(d=0.995)으로 투영 후 도면 경계로 클램프하고 놓는 속도와 함께 카메라 스프링(1.0/0.55)에 인계 | 추적 1.0/0.12, 표시 0.96→1 + opacity(1.0/0.22) | 추적·관성 없음 |
| 7a | **슬라이딩 필** (`pill.mjs`) — 도구(選択/パン), 인스펙터 탭, 레이어 정렬, 설정 언어/테마 | 선택 표시가 하나의 필로 이동 | translateX + scaleX(0.9/0.3), 정착 시 실제 폭을 1회 쓰고 scaleX=1(정지 상태에서 모서리 왜곡 없음). V/H·화살표 등 키보드 = 즉시 | 즉시 |
| 7b | **컨텍스트 메뉴** (`menu.mjs`) | 우클릭(드래그 없을 때, 우드래그는 팬 유지) 위치에 앵커. 가장자리에서 좌/상으로 뒤집히고 transform-origin도 같이 뒤집힘. 選択部分を拡大·全体表示·フォーカスモード·同じレイヤを選択·このレイヤだけ表示·このレイヤを隠す·すべて表示·AIに指示·移動量を入力·IDをコピー·削除(→변경안, 바로 지우지 않음) | 0.96→1(0.86/0.24), 닫힘 opacity(0.14). 키보드(ContextMenu/Shift+F10)는 선택 중심에 즉시. ↑↓·Home/End·첫 글자·Esc/Tab | 즉시 |
| 7c | **hover-intent 툴팁** (`tooltip.mjs`) | 아이콘 버튼·축 라벨·solo 버튼. 지연 550ms, 즉시 사라짐, 닫힌 뒤 400ms 안 이웃은 지연·애니메이션 없이 즉시. fine pointer만, 키보드 포커스는 즉시 | 0.97→1(1.0/0.18) | 즉시 |
| 7d | **레이어 정렬/단독 표시** | 정렬 전환 시 행이 새 위치로 FLIP(transform), 단독(S 버튼·Alt+클릭·메뉴)은 클릭한 행에서 바깥으로 12ms/행(최대 220ms) 퍼지는 체크 박스 펄스 = 원인→결과 | FLIP 0.9/0.36, 펄스 0.62/0.28 | 즉시 |
| 7e | **스켈레톤 shimmer** | 도면을 여는 동안 레이어 목록·인스펙터가 형태를 유지(빈 화면 깜빡임 방지) | shimmer는 `translateX`(1.3s linear, 지속 모션) | 펄스(opacity) |
| 7f | **포커스 모드** (`.` / 메뉴) | 선택 외 전부를 흐리게(기본 레이어 opacity .14 + 채도↓, 오버레이 선택은 선명) — 복잡한 도면에서 대상 확인. 상단 안내 칩, Esc/`.`로 해제, 선택이 비면 자동 해제 | opacity 전환(.35s), 칩 y −6→0(1.0/0.35) | 칩 위치 이동 없음 |
| 7g | **저장 “정착”** | 카드가 명령바로 접힌 뒤 전송 버튼이 녹색 체크로 한 번 내려앉고 1.4s 후 복귀 + 제목 칩 펄스 | 체크 0.4→1(0.62/0.28) | 색만 |

모든 새 애니메이션은 `motion.mjs` 스프링(현재 표시값+속도에서 시작, 재타깃 시 연속)이라 도중에 다시 조작해도 끊기지 않는다.

### 9.3 서버: `POST /api/v2/edit-stream`

- 요청 본문·검증·키 미설정 처리는 `/edit`과 같다. 응답은 `application/x-ndjson` 한 줄 한 이벤트: `{t:'step', id:'load'|'search'|'propose'|'l1'|'l2', state:'run'|'ok'|'fail'|'ask', attempt, info}`, `{t:'tool', attempt, name, detail}`, `{t:'retry', attempt, code, detail, layer}`, 마지막에 `{t:'result', result}`(= `/edit` 응답 본문, 미리보기는 그대로 `/accept` 가능) 또는 `{t:'error', code}`.
- `ai/edit-loop.mjs`(읽기 전용)를 수정하지 않고 **문서화된 deps로 관찰**: `loadIR`(읽기), 공급자 `propose()` 래퍼(시도 시작, `runTool` 호출, 다음 시도의 `feedback`에서 `code:`/`detail:`을 읽어 재시도 이벤트), `applyPatchV2` 래퍼(L1 통과 → L2 시작). 재시도 단계는 마지막으로 도달한 단계로 귀속(L1=스키마·레이어 검사, L2=쓰기·재판독 검증).
- 데모(모크)도 실제 읽기 전용 도구(`entity_details`)를 한 번 호출해 타임라인의 “対象を検索”이 진짜 호출을 보여 준다.
- `mutationBusy`·Host/Origin/토큰 가드는 동일. `/edit`·`/accept` 핸들러는 손대지 않았다(다른 작업과 충돌 방지). 클라이언트는 스트림 실패 시에도 실패 카드로 정상 종료.

### 9.4 검증

- 단위(`tests/studio-motion.test.mjs` +7): 디텐트(경계 연속·단조·중심 정확·끈적임), magneticSnap, projectSnap(투영 후 스냅·클램프), scrubRate/scrubValue(러버밴드 상한), moveSnap(455/910·끝점 우선·Alt 자유·놓기 목표), 오도미터 계획(방향·9→0 감김·새 자리), 진행 리듀서(재시도·오류 귀속·최종 상태). `tests/studio-v2.test.mjs` +2: 스트림 가드/오류 이벤트/자산 화이트리스트, 실제 JWW로 이벤트 순서 `load→search→tool→propose→L1→L2→result`, 스트림 미리보기 accept, 확인 질문(`propose:ask`), 키 미설정, stale hash.
- 브라우저(인앱, 1440×900): 스켈레톤 → 선 드래그(455 디텐트 값 425.5→455→484.5로 연속, 끝점 스냅, Δ칩) → 놓기(속도 인계, 약간의 오버슈트 후 정착) → 수동 변경안 → 저장(카드가 바에 접힘, 체크 정착) → 모크 AI 편집 3회 → 이력 썸네일/스크럽 크로스페이드/미리보기/복원 → 우클릭 메뉴(진입 중 프레임 포함) → 포커스 모드 → 스크럽 필드(Shift/Alt 재기준 값 2300→2310→2340→2440→2441) → 미니맵 드래그·플릭 → 툴팁 지연/따뜻한 이웃 → 21k 도면 실시간 타임라인(L2 실행 중) → reduced motion(놓기 즉시, 카드 clip 없음).
- 스크린샷(`outputs/studio-ux/wave2/`, 미추적): `01-skeleton-loading`, `02-drag-snap-delta-chip`, `03-drag-commit-proposal`, `04-proposal-with-timeline`, `05-history-hover-thumbnail`, `06-history-scrub-crossfade`, `07-history-preview-restore`, `08-context-menu-entering-frame`, `09-context-menu`, `10-focus-mode`, `11-minimap-after-flick`, `12-tooltip-warm-neighbour`, `13-live-timeline-21k-running`, `14-21k-drag-455-proposal` (.jpg).
- 성능(腹部研修 21,209요소, JS 측정): 열기 ≈0.47s, 기본 레이어 렌더 패스 ≈0.3ms(JS), 드래그 중 pointermove+오버레이 렌더 p50 1.4ms / p95 2.0ms / 최대 3.9ms, 드래그 시작 시 1회 재배치 ≈18ms(한 프레임), 모크 스트림 편집 ≈5.6s(대부분 L2 재판독). 이력 스크럽은 opacity만 바꾸므로 프레임당 캔버스 재그리기 없음.

### 9.5 한계·후속

- 이력은 클라이언트 메모리(세션 동안, 최대 20). 새로고침하면 목록은 사라진다(서버 undo 스택은 남음). 복원은 undo를 순차 호출.
- 드래그 시작 시 21k 도면에서 기본 레이어 재배치가 한 프레임(≈18ms) 걸린다. 선택만 별도 캔버스로 빼면 없앨 수 있다.
- 미니맵 뷰포트는 패널 아래까지 포함한 캔버스 전체 기준(안전 영역 아님).
- 인앱 브라우저 창이 가려지면 rAF가 멈춰 워치독(100ms) 클록으로만 진행되어, 프레임 샘플은 실제 60fps보다 성기게 기록됐다(동작 상태 수렴은 정상).
- 진행 이벤트는 runEdit의 deps 관찰이라 “모델이 생각 중”과 “도구 호출 사이” 구분은 없다(対象を検索 단계에 포함). 실제 Claude/OpenAI 키로는 미검증.
- 혼합 축척 선택은 드래그 이동 불가(인스펙터 이동은 가능).

### 9.6 참고(크레딧)

- Emil Kowalski 스킬(MIT): `find-animation-opportunities`(관문·기각 목록 형식), `improve-animations` + `AUDIT.md`(8개 범주), `review-animations/STANDARDS.md`(시간 예산·툴팁 지연 생략·키보드 무애니메이션), `animate/RECIPES.md`(트리거 원점 팝오버·툴팁), `apple-design`(잡은 오프셋 유지, 투영 후 스냅, 속도 인계, 러버밴드). 텍스트·코드는 복사하지 않고 원칙만 적용.
- coss ui(AGPLv3 — 코드 미참조): Context Menu, Tooltip, Tabs/Segmented Control, Number Field, Skeleton 컴포넌트 구성을 아이디어로만 참고.
- obsidianUI(MIT): Spotlight 류 강조와 텍스트 리빌 아이디어(1차에서 사용), 2차는 반영 없음.
- Originkit: 애니메이션 숫자/텍스트 효과 참고만(장식 효과는 기각).
- Componentry: Magnetic 류 장식은 기각. 숫자 롤은 일반적인 “number ticker/odometer” 패턴(Magic UI 등 공개 예제의 아이디어)을 참고해 자체 구현.
