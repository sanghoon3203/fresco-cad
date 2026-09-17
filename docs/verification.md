# Gate 0A 검증 기록

최신 성능 변경과 gate 0B 판정은 [성능 검증 보고서](performance-0b.md)를 따른다. 아래 기록은 2026-09-11의 gate 0A 이력이다.

판정 날짜: **2026-09-11 JST**. 이번 gate는 정의 문서와 macOS 로컬 실행 가능한 최소 캔버스를 끝까지 검증하는 범위다. **이 좁은 gate는 통과**, Phase 0/1 전체 및 성능/호환성/출시 게이트는 미통과·미검증 상태다.

## 장비·도구

| 항목 | 실제 환경 |
|---|---|
| 컴퓨터 | MacBook Air Mac16,12 · Apple M4 CPU 10코어/GPU 8코어 · 16 GB |
| OS | macOS 26.6.2, build 25G83 · arm64 |
| 앱 | Mach-O 64-bit arm64 · C++20 · Release -O3 |
| Qt | 공식 공개 6.8.3 macOS universal SDK, 동적 링크 |
| 빌드 | AppleClang 21.0.0.21000101 · CMake 3.31.6 · Ninja 1.11.1 |
| SDK | 설치된 macOS 15.4 SDK. 26.5 SDK는 Qt 6.8.3의 AGL 링크 때문에 실패 |
| 렌더러 | Qt Quick threaded render loop · Metal · Apple M4 |
| 화면 | benchmark 2640×1660 physical pixels, DPR 2; driver vsync 16.67 ms |
| 전원·열 상태 | 고정/계측하지 않음; 다른 컴퓨터 및 120Hz 장비로 일반화하지 않음 |

SDK 다운로드 도구 aqtinstall 3.3.0 및 CMake/Ninja는 `work/tooling`에 격리했다. SDK는 `work/qt`, 빌드 중간 산출물은 `work/build`에 있다. 외부 프로젝트 코드를 CAD 소스로 포함하지 않았다. 상용 라이선스 구매·계약, 외부 전송, 계정·비밀 입력을 수행하지 않았다.

## 자동 검사

| 검사 | 실제 결과와 범위 |
|---|---|
| 네이티브 빌드 | arm64 앱 및 검사 실행파일 빌드 성공. [로그](../evidence/build.log) |
| 문서 | **131개 통과**. 정확한 double/다국어 왕복, 원자 transaction, stale revision, ID/스키마/중복 key/UTF 경계, 100k undo/redo, 크기 상한, 외부 변경/잠금/백업 실패 시 원본 유지 |
| 캔버스·QML | **95개 통과**. 실제 QQuickWindow mouse/key 이벤트, 좌표/줌/스냅/선·호·문자, 선택/이동/삭제/레이어/undo, QML grouped number 파싱과 빈 입력, 숨김 레이어 작도 거절 |
| 저장·PDF | 내부 형식 왕복, 가시 레이어만 출력, 작은 sweep와 큰 시작각의 vector path, A3 초과 거절, 기존 PDF 보존 |
| CTest 시간 | 최종 회귀 실행 0.71초: core 0.05초, canvas 0.66초. [상세](../evidence/ctest.log), [요약](../evidence/ctest-summary.log). 속도 목표로 해석하지 않음 |
| 번역·색 대비 | 3개 locale, 각 94개 key 및 오류 key 일치. 주요 텍스트 최소 5.695:1, 검사한 focus 최소 5.098:1. **9개 조합** 통과. [값·범위·hash](../evidence/catalog-contrast.json) |

Qt 도구를 제한된 셸에서 실행하면 CPU feature 조회가 막혀 NEON 오류로 종료됐다. 승인된 로컬 실행에서는 정상 동작했다. Qt Core/Canvas 검사에는 강제 종료 주입, 전원 차단, 비협조 writer의 마지막 rename 경합, 외부 CAD 코퍼스가 포함되지 않았다.

## 화면 확인과 PDF

[일본어 기본 창](../evidence/canvas-ja.png), [한국어 선택 상태](../evidence/canvas-ko-selected.png), [영어 1000×700 창](../evidence/canvas-en-compact.png)을 앱의 실제 `grabWindow()`로 생성해 육안 확인했다. 조작·숫자 입력은 위 자동 검사로 별도 검증했다. 화면을 생성한 사실을 IME 합성/확정, VoiceOver/Narrator, 키보드 전체 시나리오 또는 모든 UI 상태의 사람 승인으로 해석하지 않는다.

[예제 PDF](../examples/office-a3-1-100.pdf)는 Poppler로 전체 페이지를 렌더해 도형·호·문자 배치·잘림을 확인했다. pypdf 검사에서 페이지 1장, raster image 0개, cubic arc, 일본어 `会議室`/`ラウンジ` 및 영어 텍스트 검색을 확인했다. 모델 10000 mm 외곽 선은 출력 99.999999672 mm로 1:100 길이 검사(종이 위 허용 0.01 mm)를 통과했다. MediaBox는 Qt가 point 단위로 표현한 약 420.16×297.04 mm다. [원시 값](../evidence/pdf-check.json).

일부 PDF 추출 공백이 제어 문자/탭으로 나오고 `面`의 호환 글자 매핑 차이가 관찰됐다. 따라서 **전체 텍스트 추출 동등성·Jw 글꼴 보존은 미통과**다. PDF cubic 근사의 큰 반지름 오차, 실물 프린터, 출력 골든 코퍼스 비교도 미검증이다. 합성 도면의 저장 모델 Unicode 왕복과 PDF 검색·추출은 별개 검사다.

## 당시 성능 판정 — 이전 측정기

| 측정 | 결과 |
|---|---|
| 합성 장면 | 100,000 entities = 선 80,000 + 호 19,000 + 문자 1,000, 3 레이어 |
| 동작 | 매 frameSwapped 후 중앙 기준 1.01× / 역배율 교대 줌 |
| 표본 | 첫 interval 제외, 150개 |
| frame interval p50 | **33.329 ms** |
| frame interval p95 | **34.250 ms** |
| 목표 | 16.7 ms 이하 — **미달** |
| 물리 pointer-to-preview | **미측정**; synthetic 이벤트 검사 시간으로 대체하지 않음 |

[측정 JSON](../evidence/benchmark-100k.json), [Metal·해상도 로그](../evidence/benchmark.log). frameSwapped 간격은 앱 처리·렌더링·디스플레이 스케줄링을 포함하며 GPU timestamp가 아니다. 실제 일본 건축 도면 코퍼스가 아닌 합성 장면이므로 대표 실무 성능 합격을 주장하지 않는다. scene 전체 재생성과 O(n) 스냅은 다음 gate의 측정·개선 대상이다.

## 남은 승인 게이트

Windows x64/ARM64 빌드·실행·패키징, 서명/notarization, 실제 JWW/JWC 코퍼스와 Jw 재개방, 자동저장·강제 종료 복구, APCA 기준/계측, IME·고대비·스크린리더, 120Hz·다중 모니터·펜, OpenMAIC/Archify sandbox 실행, 기업 AI Gateway 및 라이선스 승인은 미완료다. 각 항목의 상태는 앱 가이드와 설계 문서에 노출한다.

Gate **0B**에서 화면 재사용과 스냅 비용을 개선했다. 아래의 이전 측정값은 새로운 측정 방식과 직접 비교할 수 없다. 새 측정 결과 및 미달 기준은 [gate 0B 보고서](performance-0b.md)에 기록했다.
