# Sprint 00 — Jw 애드온 요구사항과 실행 기반

보고일: 2026-09-23 (JST). 범위: 제품 정의·모듈 계약·합성 도면 검토 UI·원본 보존 capture 도구.
판정: **기반 스프린트 구현·자동시험 완료. 실제 Jw 연동/쓰기 출시 게이트는 미통과(미시험).**

## 이번에 사용할 수 있는 것

- [실행 시제품](../../addons/jw-assistant/README.md): 일본어/영어 설정, 합성 선 도면 검사, 위치 preview, 승인형 수정, 취소, 자체 Undo, 검토 JSON.
- 14개 합성 line 객체에서 정확 중복·0길이·짧은 선 3건 탐지. 첫 두 항목을 적용하면 1건, Undo하면 3건으로 복원한다. 이는 **메모리 속 데모 변경**이다.
- 핵심 엔진에는 가까운 끝점과 허용 레이어 검사도 있으며 자동 수정하지 않는다. 실제 벽/개구부 의미를 인식했다고 설명하지 않는다.
- [Windows capture 도구](../../addons/jw-assistant/bridge/README.md): JWC_TEMP 바이트 복사·해시·환경 metadata. 원본 쓰기 없음. 공식 샘플에 근거한 두 codec의 실험용 BAT 포함.
- [요구사항](requirements.md): 25개 기능 요구사항, 12개 비기능 요구사항, 업무 가치 비교, 파일럿 계획.
- [아키텍처](architecture.md): bridge/domain/geometry/rules/UI/store/AI 경계, stale plan 차단, JEV 후보 순위 interface.
- [로드맵](roadmap.md): 즉시 MVP → 1년 제품 → 장기 프로젝트 플랫폼 및 실기 수락 기준.

검토 UI: 로컬 서버 실행 중 [http://127.0.0.1:4318/ui/](http://127.0.0.1:4318/ui/). 재시작 명령은 시제품 README에 있다. 외부 공개 사이트나 설치 파일이 아니다.

## 검증 결과

| 검증 | 결과 | 증거 / 실제 범위 |
|---|---|---|
| Node 자동시험 | 18/18 PASS | core 16 + 번역 catalog 1 + 로컬 서버 경계 1 |
| Core 회귀 | PASS | 역방향 중복, style 차이, Unicode ID, 승인 필수, stale content, plan 변조, 원본 무변경, 자원 상한 |
| PowerShell capture 시험 | PASS | 바이트 동일성·입력 보존·일본어 경로·부적합 입력·Jw 설치 경로 보호 등 테스트 파일의 범위 |
| UI 실제 흐름 | PASS | 3건 → 수정 2건 preview → 명시적 승인 → 1건 → 키보드 Undo → 3건, revision 7→8→9 |
| 취소/focus | PASS | Esc preview 취소 시 revision 7 유지, Preview→Apply / Apply→Undo / Undo→검사 focus |
| UI 언어 | PASS | 영어 즉시 전환·재로드 유지, 일본어 제목·설명·설정 전환 |
| 좁은 화면 | PASS (한정) | CSS viewport 1280/640/302px에서 scrollWidth≤innerWidth, 긴 ID 줄바꿈, 도면 clipping |
| 모션 설정 | PASS (한정) | 앱 Reduce motion 체크와 적용 확인. OS assistive tech 전체 시험은 아님 |
| JSON 결과 확인 | PASS | 읽기 전용 dialog의 JSON parse 성공, synthetic-local/경고 3건 확인, Esc 후 export 버튼 focus 복귀 |
| JSON 파일 저장 | 미제공 | 앱내 브라우저 download event timeout 후 저장 성공 주장을 제거. 현재는 화면에서 결과를 읽고 복사하는 방식 |
| 구문/whitespace | PASS | app.mjs syntax, git diff --check; Windows CRLF 안내는 오류 아님 |
| 실제 Jw 호출·원본 도면 왕복·Undo | NOT TESTED | 설치된 버전과 공식 sample 읽기만 수행; 도면은 수정하지 않음 |

실행 명령(저장소 루트):

```powershell
node --test addons/jw-assistant/tests/*.test.mjs
node --check addons/jw-assistant/ui/app.mjs
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/bridge_capture.test.ps1
node addons/jw-assistant/tools/benchmark.mjs
git diff --check
```

PowerShell의 `-ExecutionPolicy Bypass`는 해당 시험 프로세스의 실행 옵션이며 시스템 정책을 변경하지 않았다. 실제 업무 배포는 서명/패키징 방식을 별도 검증한다.

## 성능 측정

2026-09-23 08:35 JST, Windows `10.0.26200 x64`, AMD Ryzen 3 7335U, Node `v24.19.0`. 1회 warm-up 후 **서로 떨어진 합성 선 10,000개**를 30회 검사:

| 값 | 측정 |
|---|---:|
| p50 | 66.8004 ms |
| p95 | 83.0395 ms |
| 최대 | 83.2453 ms |

파일 읽기·JWW 해석·native shell·화면 입력 지연은 포함하지 않는다. 조밀한 실제 건축 도면에 일반화하지 않는다. 조밀한 끝점은 비교 상한을 넘으면 중단하도록 별도 회귀시험했다. 업무시간 30% 절감은 아직 파일럿 목표이며 달성 결과가 아니다.

## 모델·디자인 적용

초기 조사/구현은 요청에 따라 GPT-5.6 SOL·TERRA로 진행했다. 이후 사용자의 변경 요청을 반영해 **GPT-6 Sol은 core/bridge 검증**, **GPT-6 Luna는 UI/번역 보완**을 맡아 저장된 결과를 이어서 작업했다. 루트 에이전트가 요구사항·통합·브라우저 확인과 이 보고서를 담당했다. 프로젝트 런타임에서 이 모델들을 호출하는 기능은 추가하지 않았다.

[당근 공식 SEED skill](https://github.com/daangn/seed-design/tree/ff8836c082d20e601eb58aea07270c5b0f98ece1/skills/seed-design)과 [Apple 인터랙션 community skill](https://github.com/naplesblue/apple-design-skill/tree/e81692da299d64b9bf38ae26db2d709fc60c8bf3)을 고정 커밋으로 프로젝트에 보관·읽고 적용했다. 라이선스·해시·적용 범위는 [디자인 기록](design.md)과 `tools/skills/provenance.json`에 있다. SEED React 패키지 또는 Apple 공식 UI를 사용한다고 주장하지 않는다.

JEV는 사용자가 설명한 “선택지 강화” 목적에 맞게 유한 후보 순위/기권 interface로 설계했다. 공급자·모델/API가 아직 없으므로 실행·성능 비교는 하지 않았다.

## 확인한 환경과 남은 범위

- 실제 저장소는 상위 작업 폴더 안의 `fresco-cad`이다. 기존 Qt/C++ CAD 코드는 변경하지 않았다.
- graphify의 기존 src 탐지는 6개 파일/약 3,747단어를 보고했다. 전체 그래프를 구축·완성했다고 주장하지 않는다.
- `C:\jww\JW_WIN.EXE`의 `10.3.6.0`과 공식 `JWW_SMPL.BAT`을 읽기 전용 확인했다. 배포 표기 `10.03.6`과 상세 해시는 bridge README에 있다.
- JWW parser/writer, 회사별 실제 profile, 지속 감사 DB, native installer, 클라우드 AI, 법규/구조 판단은 미구현이다.
- Windows Narrator/IME, 실제 200% OS DPI, Jw 창 안의 취소·Undo, 장애 복구는 별도 실기 게이트다. 640px reflow가 이 시험들을 대신하지 않는다.

## 다음 스프린트 진입점

**실제 Jw에서 작고 폐기 가능한 테스트 도면을 선택해 capture → codec/단위/축척을 확정 → line-only read-only 검사로 연결한다.** 지원하지 않는 객체가 섞이면 쓰기를 차단한다. identity 왕복·취소·Undo가 통과하기 전 실제 도면 수정 기능을 열지 않는다.

이번 스프린트는 Git commit/push/PR 또는 Jw 설치 변경을 수행하지 않았다. 코드와 문서는 작업 폴더에 보존되어 있다.
