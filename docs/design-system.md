# Fresco CAD — 디자인 시스템 초안

작성: 2026-09-11 · 상태: **Gate 0A 최소 QML 화면의 계약 초안**. 사용자 brief 및 로컬 design/AGENTS.md의 의미 기반 토큰·상태·키보드·비색상 단서 원칙을 적용한다. 완성된 디자인 시스템·접근성 인증·세 언어/OS 사용자 검증을 뜻하지 않는다.

## 단일 원천과 화면 구조

`qml/theme.json` 하나를 Qt/QML과 C++ 캔버스가 소비하는 semantic theme 원천으로 둔다. 브랜드 seed는 **Fresco Sky #C9E2FF**이며 은은한 brand surface와 선택 강조에 쓴다. seed를 본문색·포커스 대비값으로 그대로 쓰지 않는다. 대화형 요소는 Qt Quick Controls **Basic**의 동작을 사용하고 `CadButton.qml`/`Field.qml`에 실제 필요한 스타일만 모은다. SEED 구조 참고의 범위는 [통합 문서](integrations.md)에 기록했다.

| 원천/역할 | 초안 계약 | 구현·검증 경계 |
|---|---|---|
| color | surface/panel/canvas, ink/secondary/annotation, focus/selection/snap, border, error/success | semantic JSON 값과 실제 contrast pairs를 검사; 원시값을 screen에 분산하지 않음 |
| type | 시스템 기본 글꼴과 ja/ko/en fallback, 본문/보조/좌표/HUD 위계 | OS별 실제 fallback·IME·font metrics·PDF 확인 대기 |
| layout | spacing, radius, density, control height, panel width, line width | 최소 화면에 필요한 값만 원천화; raw scale 확장 대기 |
| state/recipe | 도구 선택, action/field 상태, focus, 비색상 표시 | 이 문서가 행동 계약; 전체 component-token/recipe generator 미구현 |
| motion | instant/fast/standard/slow와 enter/exit/emphasized 역할 | 포인터·스냅·고스트·좌표는 instant; 나머지 모션은 필요한 전환만 |

**raw scale → semantic → component token → recipe 생성 파이프라인은 아직 완성되지 않았다.** 현재는 하나의 semantic JSON과 최소 공유 컴포넌트다. 생성기나 빌드 체인이 없는데 모든 단계가 자동 생성된다고 설명하지 않는다. raw 수치·단위·오류 기준은 CAD 모델 계약이고 시각 theme와 혼합하지 않는다.

화면은 상단 문서 작업, 두 번째 상단 작도 도구, 왼쪽 레이어/정밀 입력, 중앙·오른쪽 캔버스, 하단 현재 명령·좌표/상태로 읽힌다. 위계는 도면과 현재 도구가 중심이다. AI·Learning·외부 형식처럼 미구현인 기능을 작동하는 버튼처럼 제시하지 않고 미지원 상태를 명시한다. 작은 창에서는 첫 작도·저장·취소 동작과 읽기 순서를 보존하며 패널 overflow/키보드 접근을 실제 창에서 검사한다.

## 컴포넌트 상태와 행동 계약

아래는 **요구 계약**이다. 각 상태의 실제 스타일·키보드·screen reader 확인은 별도 evidence가 있어야 통과다. 해당 동작이 없는 상태는 임의 연출하지 않고 N/A로 기록한다.

| 제품 컴포넌트 | default / hover / pressed / focus-visible / selected | disabled / loading / error / empty | 키보드·비색상 단서 |
|---|---|---|---|
| toolbar/action | label 유지, hover 구분, press 즉시, 뚜렷한 focus ring; 활성 도구에 선택 표시 | 불가능한 undo/redo는 비활성; 실제 비동기 작업만 loading; 오류는 문구와 다음 동작 | Tab/Shift+Tab 이동, Enter/Space 실행, 툴 label·선택 상태를 접근성 트리에 노출 |
| 정밀 field/inspector | label+mm 단위, 편집 focus, 입력 내용 유지 | 잘못된 수치에 원인 문구; 수정 전 문서 유지; 선택 없음 상태 설명 | 숫자 키보드 입력, Enter 적용, Esc 취소; placeholder를 유일한 label로 쓰지 않음 |
| layer controls | 레이어 이름과 현재 레이어, hover/focus 및 check 상태 | 현재는 고정 3개; lock/group/loading은 미구현 | 토글을 색만으로 표현하지 않음; 숨긴 레이어는 선택/스냅에서 제외 |
| viewport/HUD/snap | 입력 좌표 즉시 반영, 선택 외곽·삽입점 단서, 스냅 사각형과 상태 | 명령 준비/진행/취소 구분; 빈 문서는 새 도면 상태, 에러 시 기존 기하 보존 | 캔버스 focus, Esc 취소; 포인터 없는 정밀 입력/선택 경로를 별도 제공 |
| 문서 dialog/status | 제목·행동·결과가 연결되고 focus 위치가 예측 가능 | 저장/열기 실패 원인, 미지원 형식, 저장 변경 여부를 텍스트로 표시 | 열린 dialog 안의 Tab 순환/닫은 뒤 focus 복귀 검증; 파괴적 전환은 미저장 변경 확인 |

command palette, layer tree의 중첩/잠금, AI panel, Learning Center는 후속 컴포넌트다. 아직 구현하지 않은 상태를 CSS 색상 정의만으로 완료 처리하지 않는다. 모든 상태는 색 외에 label, 모양, check, 외곽선 또는 설명 중 적합한 단서를 갖는다.

## 정밀 조작과 모션

선은 두 점, 호는 중심→시작점→끝점, 문자는 입력값→삽입점의 최소 흐름이다. 현재 호 도구의 sweep 방향·full circle 제한은 사용자 도움말에서 명시해야 한다. 캔버스의 좌표·스냅·고스트·선택 preview에는 easing, 보간, 탄성을 넣지 않는다. pan/zoom도 실제 view 변환에 즉시 반영한다. 부드러운 패널 전환은 이 좌표 계약을 바꾸지 않는다.

현재 C++ shortcut은 V 선택, L 선, A 호, T 문자, F fit, N 다음 entity, +/- zoom, 방향키 pan, Esc 취소, Delete/Backspace 삭제 및 플랫폼 undo/redo다. 이 키는 **캔버스에 focus가 있을 때**의 행동이며 text field의 IME/편집 키를 가로채면 안 된다. 마우스 중간 버튼 pan, 우클릭 cancel, trackpad pan/보조 zoom은 각 OS에서 검증한다. Jw 양 버튼/클록 메뉴 조작 모드는 아직 없다.

장식 모션을 추가할 경우 micro motion은 200ms 이하를 기본 상한으로 하며 OS reduced-motion 선호와 앱의 축소 설정을 모두 적용한다. 스파이크에 애니메이션이 없다는 사실과 두 설정 경로 구현 완료는 다르다. OS 설정 연동·상태 유지·키보드 조작까지 확인하기 전에는 reduced motion 전체 지원이라고 쓰지 않는다.

## 언어·텍스트·접근성

UI catalog는 `qml/strings.json`의 ja-JP 기본/ko-KR/en-US 항목을 사용하며 complete message 단위로 번역한다. 문자열 연결로 문장을 만들지 않는다. 명령·오류 key는 모든 언어에서 같은 의미를 갖고 누락 key/잘못된 fallback은 검사 대상으로 둔다. 번역 catalog 존재는 일본어·한국어 IME 확정/취소, 전각/반각, fallback font, screen reader 전달 및 실제 레이아웃 동등성의 증거가 아니다.

시스템 글꼴을 사용하고 도면 text는 Unicode를 보존한다. 현재 최소 문자 표현의 선택·행 나눔·세로쓰기·폰트 설정은 완전한 일본 건축 문자 기능이 아니다. 외부 콘텐츠의 번역 fallback은 숨기지 않으며 법규·안전 번역은 전문가 미검토로 구분한다.

| 검사 | 목표/증거 | 현재 상태 |
|---|---|---|
| WCAG 2.2 AA 대비 | 일반 text 4.5:1, 큰 text 3:1, 의미 있는 UI 경계/상태 3:1; 실제 foreground/background 조합의 계산 결과 | 9개 의미색 조합 통과: [검사값](../evidence/catalog-contrast.json) |
| APCA | 사용 알고리즘/버전, 글꼴 크기·굵기와 각 의미색 조합 Lc 및 수락 기준 기록 | 측정·기준 승인 대기; WCAG 비율로 대체하지 않음 |
| keyboard/focus | 주요 작도·선택·수정·저장·취소를 pointer 없이 실행, focus 가림/손실 없음 | 사람 검증 대기 |
| 언어/IME/a11y | ja/ko/en 레이아웃, IME 합성/확정/취소, VoiceOver/Narrator·고대비·HiDPI | OS/실기기 사람 검증 대기 |
| 모션/성능 | 정밀 표시 무보간, 축소 설정 경로, 60/120Hz 장비별 evidence | 정밀 경로의 코드 계약만 확인; 실측/설정 시험 대기 |

대비 목표 근거는 W3C [SC 1.4.3 해설](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) 및 [SC 1.4.11 해설](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)이다(확인: 2026-09-11). 큰 text의 해당 크기·굵기 조건과 비활성 요소 등 예외를 실제 역할별로 적용하며 경계값을 반올림해 통과시키지 않는다. contrast script가 일부 색 조합을 통과해도 WCAG 전체 또는 접근성 전체가 통과한 것으로 확대하지 않는다. UI 장면의 실제 font size, focus, target, 읽기 순서, 오류 회복을 사람이 확인한다.

ja-JP 기본, ko-KR 선택, en-US 최소 창 화면을 실제 Qt 창으로 캡처해 확인했다. [검증 보고서](verification.md)에 결과와 제한을 기록했다. 다음 접근성 검증은 사람의 IME·스크린리더·키보드 작업 검사다.
