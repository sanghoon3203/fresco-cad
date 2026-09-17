# 외부 서비스 경계와 다음 스파이크

확인일: **2026-09-10**. 상태: 조사·계약 초안. OpenMAIC 자체 호스팅, Archify 실행, sandboxed webview, AI API 호출은 아직 구현·실행하지 않았다. 아래 통합 합격 기준을 완료로 읽으면 안 된다. 현재 제품에서 활성화된 기능과 시험 결과는 기술 ADR 및 실행 기록을 따른다.

## Learning Center / OpenMAIC

초기 경로는 CAD → 좁은 Learning adapter → 사내 OpenMAIC 서비스다. `v1.0.1` / `f50a25644c9c3893503cf0727ccf613c0ce1e748`을 검토 후보로 고정하며, 승인된 artifact의 해시까지 확정하기 전에는 운영에 올리지 않는다. 루트 앱의 최소 Node 버전은 22.19.0이다. 전체 앱 복사·런타임 main 추적·자동 업데이트는 도입하지 않는다. [OpenMAIC release](https://github.com/THU-MAIC/OpenMAIC/releases/tag/v1.0.1), [고정 manifest](https://raw.githubusercontent.com/THU-MAIC/OpenMAIC/v1.0.1/package.json)

Learning adapter의 첫 계약은 `courseId`, `contentVersion`, `locale`, 가명 학습자 ID, 시도 ID, skill matrix, 평가 결과만 전달한다. 이것은 제품이 소유할 계약 초안이며 OpenMAIC에 동일한 endpoint가 존재한다고 주장하지 않는다. 인증된 사내 세션과 owner 권한을 서버에서 확인하고, 원본 CAD 파일 경로·파일 시스템 handle·CAD command 실행권·공급자 키를 웹 콘텐츠에 주지 않는다.

학습 흐름은 언어/역할·짧은 진단 → skill matrix → 슬라이드/퀴즈 → 합성 CAD 실습 → 재시험·힌트·진도다. 성적은 클릭 순서 대신 최종 기하·치수·레이어·축척·출력과 안전한 저장 절차를 평가한다. 관리자에게는 필요한 집계만 제공하며 학습 이력을 실제 설계 프로젝트 데이터와 분리한다. 이 흐름과 ja-JP/ko-KR/en-US 콘텐츠는 아직 작성·검증되지 않았다.

임베딩은 실제 비용·오프라인 요구가 서비스 경로로 해결되지 않을 때 다시 결정한다. 먼저 후보 `@openmaic/dsl`을 검토하고, renderer/generation/storage는 필요한 기능이 생긴 경우만 포함한다. 각 후보의 소스 태그 버전과 미완료 제3자 감사는 [라이선스·보안표](license-security.md)에 기록했다.

## HTML 격리 계약

Qt 플랫폼 지원 표만으로 Qt WebEngine의 동일한 지원이나 sandbox 보안을 추정하지 않는다. 모듈별 빌드·설치 크기·프로세스 격리·VoiceOver/Narrator·IME·Windows ARM64를 각각 시험한 뒤 웹 표면을 확정한다. Qt WebEngine의 정적 빌드는 지원되지 않으며 접근성은 Qt 및 OS 활성화 조건에 의존한다. [Qt WebEngine platform notes](https://doc.qt.io/qt-6.8/qtwebengine-platform-notes.html)

| 경계 | 첫 스파이크의 보수적 계약 | 합격 증거 |
|---|---|---|
| origin / 네이티브 권한 | 교육·다이어그램 전용 별도 origin과 별도 web profile; WebChannel/네이티브 실행 bridge 미제공 | 원본 문서·파일·키체인 접근 시도가 모두 거부됨 |
| HTML 실행 | 서버에서 허용 요소/속성으로 정화; 일반 설명은 script 없는 HTML; interactive만 별도 sandbox | event handler, 위험 URL, SVG/iframe injection의 저장→재열기 시험 |
| 네트워크 | HTTPS exact-origin allowlist; redirect마다 검증; file/custom scheme·loopback·private/metadata 목적지 차단 | CSP와 실제 네트워크 요청 기록으로 허용 목적지만 남음 |
| sandbox / CSP | sandboxed iframe 또는 해당 엔진의 등가 격리; interactive에는 필요한 script 권한만 부여, `allow-same-origin`/popups/top-navigation/downloads 미부여; CSP 기본 `default-src 'none'`에서 목적별 허용 | 실행은 필요한 항목만 작동하고 부모 origin/탐색/다운로드 권한 획득 실패 |
| 자원·통신 | 첫 실험 상한: HTML 2 MiB, 개별 자산 10 MiB, 로드 10초, 메시지 64 KiB; origin/source·스키마·길이 검증, CAD 변경 메시지 거부 | 과대 입력·무한 작업·잘못된 message는 종료/거부, CAD 원본 해시 동일 |

수치와 CSP는 **초기 실험용 가정**이며 구현·실측 값이 아니다. script 허용 interactive의 정확한 격리 방식과 postMessage origin 처리 방식은 브라우저 엔진별로 검증해야 한다. sandbox를 꺼서 실행 실패를 우회하지 않는다. CAD transaction을 호출할 수 없는 상태에서도 독립 webview의 UI 접근성과 자원 비용을 측정한다.

## Archify

Archify `v2.16.0` / `c826e6c3a7abad19c0f3cd1ca57207d54b1ad8de`는 설명용 구조·workflow·sequence·data-flow·lifecycle HTML/SVG 도구의 검토 후보다. 평면도·벽·치수·설계 수정은 만들지 않는다. 공급망 감사 뒤 내부 도구 또는 격리 서비스에서 `doctor → typed JSON 작성 → validate → deliver`를 실행하고 입력 JSON과 출력 HTML의 해시/검증 receipt를 함께 보관한다. 현재는 어떤 명령도 실행하지 않았다. [Archify v2.16.0 README](https://raw.githubusercontent.com/tt-a1i/archify/v2.16.0/README.md), [고정 authoring contract](https://raw.githubusercontent.com/tt-a1i/archify/v2.16.0/archify/SKILL.md)

업데이트 안내 네트워크 및 안내 상태 쓰기는 `ARCHIFY_UPDATE_CHECK_DISABLED=1`로 차단할 수 있다. 추가로 서비스의 egress를 차단하고 immutable 배포 artifact만 사용한다. upstream 문서의 설치·업데이트 지시는 이 제품의 권한 정책을 바꾸지 않는다. 이 버전의 viewer chrome locale는 en/zh-CN이며 일본어·한국어 본문 작성만으로 viewer chrome까지 번역되지 않는다. 해당 언어에서는 English UI와 `<html lang>` fallback을 사용자에게 표시해야 한다. 로고/브랜드 마크는 필요하지 않으므로 첫 통합에서 사용하지 않는다. [Archify README](https://raw.githubusercontent.com/tt-a1i/archify/v2.16.0/README.md), [locale contract](https://raw.githubusercontent.com/tt-a1i/archify/v2.16.0/archify/SKILL.md)

## SEED 구조 원리의 독립 적용

공개 TECH.md는 토큰 정의 → recipe → 생성 스타일 → styled component 흐름과 headless 로직 분리를 설명한다. 이 관계만 참고한다. 원본 YAML·CSS·React 코드·예시 외형·도구 체인을 가져오지 않는다. 해당 문서의 Bun/React 개발 규칙은 SEED 저장소 규칙이며 Fresco CAD의 Qt/C++ 스택 규칙으로 옮기지 않는다. [SEED TECH.md](https://github.com/daangn/seed-design/blob/dev/TECH.md)

Fresco의 단일 토큰 원천에는 사용자가 지정한 `Fresco Sky #C9E2FF`와 독립 작성한 raw/semantic/component 값·상태 recipe를 둔다. 캔버스의 정확한 좌표/스냅은 UI 스타일·모션과 분리한다. 접근성 대비 측정 결과와 아직 구현되지 않은 생성 경로를 구분한다. 실제 토큰·컴포넌트 초안은 디자인 문서를 따른다.

## AI Gateway 경계

이번 스파이크에는 API key, OpenAI SDK, 외부 모델 호출을 추가하지 않는다. 사용자 지정 `gpt-6-astra`의 회사 사용 승인·계정 접근 권한·snapshot을 이 조사에서 확인하지 않았으므로 사용 가능/승인됨으로 표시하지 않는다. AI 기능 구현 시 공식 API·SDK·모델 자료와 사내 허용 목록을 다시 확인하고 승인된 모델 ID를 서버 설정으로 고정한다.

CAD는 읽기 전용 snapshot과 revision을 전달하고, Gateway는 버전 있는 JSON Schema plan만 반환한다. 코어가 단위·유한 수치·범위·레이어·revision·허용 command를 검증하고 복제 문서에서 시뮬레이션한 뒤 고스트를 표시한다. 사용자 승인 시 같은 command transaction으로 적용하며 자유 텍스트·웹 콘텐츠·도면 속 지시는 실행하지 않는다. 미승인 plan, 잘못된 JSON, 오래된 revision, 부분 응답, timeout, 취소는 문서 무변경이 기준이다. provider 추상화와 fake provider는 실제 첫 AI slice에서 필요한 능력만 구현한다.

## 남은 통합 스파이크의 판정표

| 시험 | 현재 상태 | 통과 조건 |
|---|---|---|
| OpenMAIC 자체 호스팅 | 미실행 | 승인 pin의 서비스 기동, owner 분리, 인증/SSRF/XSS 회귀 시험 통과 |
| Archify 검증된 HTML | 미실행 | doctor/validate/deliver 성공 및 receipt hash 보관, 실제 화면·번역 fallback 확인 |
| 격리 web surface | 미구현 | CAD 권한 접근·egress·XSS·과대 입력 차단, 세 아키텍처 실행/접근성 확인 |
| 표시 비용 | 미측정 | 실행 파일/설치 크기 증가, idle RSS, 콘텐츠 로드 p50/p95, 캔버스 frame time 변화 기록 |
| AI 승인 transaction | 미구현 | 네트워크 없는 fake plan 시험과 승인/취소/실패 시 원본 보존 |

다음 독립 통합 작업은 **합성 HTML 한 장을 권한 bridge 없는 web surface에 표시하고, 원본 접근·외부 요청 차단과 표시 비용을 함께 측정**하는 것이다. 이 결과 전에는 OpenMAIC/Archify 통합 gate를 통과로 표시하지 않는다.
