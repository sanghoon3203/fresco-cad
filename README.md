# Fresco CAD — native canvas spike

**2026-09-23: Jw_cad 애드온 개발을 먼저 진행합니다.** 별도 [Jw Assistant 시제품](addons/jw-assistant/README.md), [요구사항](docs/jw-assistant/requirements.md), [스프린트 보고서](docs/jw-assistant/sprint-00-report.md)를 추가했습니다. 아래는 기존 통합형 Qt/C++ CAD 시제품의 이력입니다.

**2026-09-24: 일본 업무·AI API 조사에 따라 계획을 v0.2로 개정했습니다.** [개정 제품 계획](docs/jw-assistant/product-plan-v2.md) · [개발 로드맵](docs/jw-assistant/roadmap.md) · [조사 스프린트 보고](docs/jw-assistant/sprint-01-research-report.md). API 연결·실제 Jw 쓰기는 아직 구현/검증 전입니다.

**2026-09-24: JWC_TEMP 읽기 전용 가져오기를 구현했습니다.** 실제 Jw 10.3.6의 테스트 선 캡처를 읽고, 좌표 단위 확인·그룹 선택·검사 범위를 일본어/영어 UI에 표시합니다. [실행 안내](addons/jw-assistant/README.md) · [I1 구현/실기 보고](docs/jw-assistant/sprint-02-i1-report.md). UTF-8 래퍼 인식과 세션 격리 등 호환성 게이트는 남아 있습니다.

**2026-09-25: 캡처 무결성 검증과 수동 세션 디렉터리 분리를 추가했습니다.** 메타데이터 불일치/미완료 파일은 검사를 차단하고, 일본어·영어 화면에서 확인 상태를 표시합니다. Node 32개 검사와 Windows bridge 검사 통과. [I1B 스프린트 보고](docs/jw-assistant/sprint-03-i1b-report.md). 실시간 창 연결·동시 실행 보장·실제 도면 쓰기는 미구현입니다.

**2026-09-25: 사무소 규칙·검토 메모·34개 레이어 분류·현장 마감 확인을 추가했습니다.** 읽기 전용 시제품이며 47개 자동 검증과 브라우저 저장/재열기 검증 통과. [Sprint 04 보고](docs/jw-assistant/sprint-04-i2a-report.md) · [현장 확인 계약](docs/jw-assistant/field-coordination.md).

**2026-09-26: 위치별 현장 메모와 백업 복원을 추가했습니다.** 화면 전환 시 초안을 보존하고, 기존 데이터 변환·복원 미리보기·이전 정상본 보존을 검증했습니다. 자동 검사 54개 통과. [Sprint 05 보고](docs/jw-assistant/sprint-05-i2b-report.md).

**Phase 0, gate 0B: 실패 — 화면 재사용·입력 비용 개선과 회귀 검사는 통과했으나 프레임 성능 목표에 미달.**

Gate 0A의 로컬 캔버스 검증은 유지됩니다. [최신 성능 보고서](docs/performance-0b.md).

[Fresco CAD.command](Fresco%20CAD.command)를 열면 실행됩니다. 기본 언어는 일본어이며 오른쪽 위에서 한국어·영어로 바꿀 수 있습니다. 이 런처는 현재 작업 폴더의 `work/build`와 `work/qt`를 사용하는 **로컬 개발 빌드**입니다. 서명된 배포 패키지나 다른 컴퓨터로 옮길 수 있는 설치본은 아닙니다.

## 1분 확인

1. `線 / 선 / Line`을 선택하고 캔버스에서 두 점을 클릭합니다. `Esc`는 진행 중인 작도를 취소합니다.
2. `선택`에서 도형을 클릭하거나 캔버스에 포커스를 두고 `N`으로 순회합니다. 왼쪽 패널 아래의 이동량으로 이동하고 undo/redo를 확인합니다.
3. `저장`으로 새 `.fresco` 파일을 만듭니다. 예제 [office.fresco](examples/office.fresco)도 열 수 있습니다.

호는 중심→시작점→끝 방향의 반시계 방향 3점 입력입니다. 문자는 왼쪽 입력란을 편집한 뒤 문자 도구로 배치합니다. 가운데 버튼·방향키는 팬, 휠·+/−는 줌, F는 전체 보기입니다. 도면의 예제 치수선은 연관 치수가 아닌 일반 선·문자입니다.

## 실제 범위

- C++20 mm/double 문서, 선·호·문자, 100 mm 격자 및 끝점·호 중심 스냅, 선택·수치 이동·삭제, 고정 3개 레이어, transaction undo/redo.
- 내부 `.fresco` 버전 1의 엄격한 읽기/쓰기, 임시 파일 재검증·원자 교체·외부 변경 충돌 검사·직전 정상본 보존. 새 이름으로 기존 파일을 덮어쓰지 않습니다.
- 보이는 레이어의 **A3 가로·1:100** 벡터 PDF 출력. 범위 초과·기존 PDF는 거절합니다. [출력 예제](examples/office-a3-1-100.pdf).
- ja-JP/ko-KR/en-US 카탈로그, 기본 Qt 키보드 controls와 가시적 focus, 장식 애니메이션 없는 정밀 입력. IME·스크린리더·고대비의 사람 검증은 별도입니다.

**미구현:** JWW/JWC, DXF/DWG 및 기타 외부 형식 가져오기·쓰기, 연관 치수, 자동저장·강제 종료 복구, Jw 조작 모드, AI Gateway/AI 기능, OpenMAIC/Archify 실행 통합, SSO·서명·자동업데이트. 앱의 가이드에서도 미지원 범위를 표시합니다. Windows x64/ARM64의 빌드·실행·패키징은 아직 검증하지 않았습니다.

## 저장과 복구의 구분

`drawing.fresco`는 마지막 저장본, `drawing.fresco.last-good`는 **그 이전의 정상 저장본**입니다. 수동 복구하려면 `.last-good`를 별도 `recovered.fresco`로 복사해서 여세요. 이 경로는 검사했지만 미저장 변경을 복구하는 자동저장/journal은 없습니다. 오류가 나면 문서와 기존 파일을 유지하며 오류를 표시합니다. 비협조 외부 프로그램이 마지막 검사 직후 쓰는 극히 짧은 경쟁 구간은 남습니다.

## 검증 결과

[최신 성능 보고서](docs/performance-0b.md)와 [gate 0A 이력](docs/verification.md)을 확인하세요. 최종 260개 문서·캔버스·화면 재사용 검사, Metal 화면 비교 12개, 세 언어 94개 키/9개 색 대비 조합 검사가 통과했습니다. 고정 창의 10만 합성 객체에서 확대 입력 처리 p95는 6.869→1.250ms로 줄었지만, 프레임 간격 p95는 확대 18.675ms / 이동 36.516ms / 포인터 35.933ms로 16.7ms 목표에 미달합니다. 물리 포인터부터 화면 표시까지의 지연은 미측정이며, 이 합성 장면의 작은 문자는 표시 임계값 아래라 그리지 않습니다. Phase 0/1 전체 통과나 Jw_cad 대체를 주장하지 않습니다.

## 다시 빌드

현재 작업 폴더 최상위에서 실행합니다. Qt 6.8.3의 오래된 AGL 링크 요구 때문에 설치된 macOS 15.4 SDK를 사용했습니다. SDK/Qt 바이너리를 수정하지 않았습니다.

```sh
work/tooling/bin/cmake -S outputs/fresco-cad -B work/build -G Ninja \
  -DCMAKE_MAKE_PROGRAM="$PWD/work/tooling/bin/ninja" \
  -DCMAKE_PREFIX_PATH="$PWD/work/qt/6.8.3/macos" \
  -DCMAKE_OSX_SYSROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk \
  -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_BUILD_TYPE=Release
work/tooling/bin/cmake --build work/build -j 4
work/tooling/bin/ctest --test-dir work/build --output-on-failure
work/tooling/bin/python outputs/fresco-cad/tests/catalog_check.py
```

다른 개발 환경에서는 Qt 6.8 이상 Core/Gui/Quick/QuickControls2/Test, CMake 3.24 이상, C++20 컴파일러를 준비하고 해당 Qt prefix/SDK를 지정해야 합니다. 위 명령만 이 Mac에서 실행했습니다. Codex 샌드박스는 Qt CPU 기능 조회를 차단해 `neon` 오류를 낼 수 있으며 이 작업에서는 승인된 로컬 도구 실행으로 검증했습니다.

## 설계 자료

[제품 정의](docs/product-brief.md) · [호환성·코퍼스 매트릭스](docs/compatibility-matrix.md) · [기술 ADR](docs/adr-001.md) · [디자인 토큰·상태 계약](docs/design-system.md) · [라이선스·보안표](docs/license-security.md) · [외부 통합 조사](docs/integrations.md)

다음 작업은 gate 0B의 남은 입력·프레임 갱신 병목 개선입니다. 회사 라이선스 승인과 Windows 실기기 검증은 별도 게이트입니다.
