# Gate 0B — 화면 재사용·입력 비용 검증

**Phase 0, gate 0B: 실패.** 2026-09-14 JST. 구현·정확성 검사는 통과했으나, 세 동작 모두 frame interval p95 16.7 ms 기준에 미달했다. 합성 입력에서 제출까지의 시간은 물리 pointer-to-preview 50 ms 기준의 대체 측정이 아니다.

## 실제 변경

포인터만 움직이면 기존 격자·도면 노드를 보존하고 고스트·십자선만 갱신한다. 문서 revision, 선택, 레이어 가시성, 팔레트, 화면 크기·좌표·배율 변화는 해당 노드를 다시 생성한다. 큰 좌표의 작은 이동을 놓치지 않도록 캐시 키의 double을 정확히 비교한다. 확대·이동 시에는 화면 좌표의 선 굵기와 호 분할, 문자 표시 판정을 그대로 다시 계산한다.

스냅은 기존 순서와 거리 판정을 유지하면서 객체마다 만들던 임시 배열을 제거했다. 선택이 없으면 속성 표시용 전체 객체 탐색을 생략한다. 문서·저장 모델, PDF 구현, UI 디자인은 변경하지 않았다. 공간 인덱스와 새 렌더링 의존성은 추가하지 않았다. [렌더러 변경](../evidence/gate0b/renderer.patch).

## 측정 방법과 경계

MacBook Air Mac16,12 / Apple M4 / 16 GB / macOS 26.6.2 25G83 / Qt 6.8.3 Release arm64 / threaded Metal에서 실행했다. 창은 1320×800 logical, 2640×1600 physical, DPR 2이고 캔버스는 1051×641 logical이다. 모든 비교에서 초기 중심·배율·화면 크기가 일치한다.

측정기 v4는 렌더러와 독립된 정밀 60 Hz 타이머로 30회 준비 입력 뒤 150회 측정 입력을 전달한다. 확대는 30회 1.002배 후 30회 역배율, 이동은 30회 +4px 후 30회 −4px이다. 늦어진 타이머를 뒤늦게 몰아서 재생하지 않는다. 모든 입력 시각, 화면 좌표·배율, 제출 시각, 병합 횟수를 저장한다. p95는 정렬한 전체 표본의 nearest rank이며 느린 표본을 제거하지 않는다. [원시 비교 및 소스·실행파일 SHA256](../evidence/gate0b/comparison.json).

이전 gate 0A 측정기는 frameSwapped 전달 뒤 다음 입력을 보내는 구조였다. 초기 화면 배치도 달라 당시 34.250 ms와 아래 수치를 직접 비교할 수 없다. 이번에는 같은 v4 측정기를 변경 전·후 렌더러에 각각 빌드했다. 중간 측정기의 입력 상쇄와 운영체제 창 높이 조정 문제를 수정한 뒤 모든 비교를 다시 수집했다.

프레임 간격은 render thread의 frameSwapped 사이 시간, CPU 구간은 beforeSynchronizing→afterRendering, 합성 입력 지연은 이벤트 전달 시작→afterFrameEnd이다. 마지막 값은 GPU 완료·실물 화면 표시 시간이 아니다. 의미는 [Qt QQuickWindow 신호 문서](https://doc.qt.io/qt-6.8/qquickwindow.html#afterFrameEnd)를 따른다. 노드 재사용은 [Qt Scene Graph의 retained rendering](https://doc.qt.io/qt-6.8/qtquick-visualcanvas-scenegraph-renderer.html)에 기반한다. 공식 문서 확인: 2026-09-14; 실행 SDK는 6.8.3이다.

장면은 선 80,000 + 호 19,000 + 문자 1,000의 합성 100,000 객체다. 이 배율의 문자 높이는 약 1.00–1.06px여서 기존 2px 표시 제한에 따라 그리지 않는다. 따라서 읽을 수 있는 문자 1,000개를 그리는 성능이나 일본 건축 실무 코퍼스 합격을 주장하지 않는다. 전원·온도·다른 데스크톱 작업은 통제하지 않았고 각 조건은 1회 비교다. 빌드는 모두 마친 뒤 두 앱을 순차 실행했다.

## 결과

모든 시간은 p95 ms이며 **변경 전 → 변경 후** 순서다.

| 동작 | 입력 처리 | CPU 동기화·기록 | 프레임 간격 | 제출된 입력 / 150 |
|---|---:|---:|---:|---:|
| 확대 | 6.869 → 1.250 | 5.771 → 5.290 | 42.578 → 18.675 | 74 → 150 |
| 이동 | 7.831 → 1.259 | 5.675 → 7.307 | 39.110 → 36.516 | 76 → 102 |
| 포인터·스냅 | 6.882 → 3.518 | 5.619 → 4.458 | 35.032 → 35.933 | 76 → 86 |

| 최종 동작 | 최신 입력→제출 | 가장 오래 기다린 미반영 입력→제출 |
|---|---:|---:|
| 확대 | 19.696 | 19.696 |
| 이동 | 19.086 | 34.682 |
| 포인터·스냅 | 21.488 | 24.503 |

입력 처리 비용은 줄었다. 프레임 간격의 일관된 개선은 확인되지 않았다. 특히 이동 CPU와 포인터 프레임 간격은 이 비교에서 증가했다. 확대가 150개 입력을 모두 제출한 결과도 다른 동작의 60fps 보장을 뜻하지 않는다. 병합된 입력은 원시 기록에 남겼으며 제출되지 않은 마지막 입력은 없다. [표본 재계산 검사](../evidence/gate0b/benchmark-check.log).

## 정확성·화면 검증

최종 빌드와 CTest 3종이 통과했다: 문서 131개, 캔버스·QML·PDF 95개, 캐시·큰 좌표·선 굵기 검사 34개로 **260개**다. [빌드](../evidence/gate0b/build.log), [검사 상세](../evidence/gate0b/ctest.log). 번역 3개 locale × 94개 key와 9개 색 대비 조합도 통과했다. [카탈로그 검사](../evidence/gate0b/catalog-contrast.json).

실제 Metal 창에서 일본어·한국어·영어 문자의 픽셀 존재를 확인하고, 재사용 화면과 같은 상태를 전체 재생성한 화면을 **12개 상태에서 픽셀 단위로 비교하여 모두 일치**했다. hover, 화면 밖 이동·복귀, 2px 미만·초과 확대, 선택 문자 변경, 레이어 숨김·복원, 색 변경을 포함한다. [실행 기록](../evidence/gate0b/visual.log), [기본 문자](../evidence/gate0b/visual/01-initial.png), [한국어 선택](../evidence/gate0b/visual/09-korean-selected.png). 문자 배치·호·선의 캡처를 육안으로도 확인했다. 이는 IME·폰트 왕복·실무 골든 도면 승인을 뜻하지 않는다.

## 재실행

작업 폴더 최상위에서 실행한다. macOS Metal 화면 검사는 데스크톱에서 실행하며 offscreen CTest와 구분한다.

```sh
work/tooling/bin/cmake --build work/build -j 4
work/tooling/bin/ctest --test-dir work/build --output-on-failure
QSG_RHI_BACKEND=metal work/build/render_visual_check work/gate0b/recheck-visual
for mode in zoom pan hover; do
  work/build/fresco_cad.app/Contents/MacOS/fresco_cad \
    --benchmark "work/gate0b/recheck-$mode.json" --benchmark-mode "$mode"
done
work/tooling/bin/python outputs/fresco-cad/tests/benchmark_check.py work/gate0b/recheck-*.json
```

변경 전 앱은 로컬 `work/gate0b/before-v4.app`에 보존했다. 배포용 소스에는 이전→최종 renderer.patch와 SHA256을 포함한다. 이전 렌더러 재현은 별도 소스 복사본에서 그 패치를 역적용하고 같은 최종 main.cpp로 빌드한다. Qt SDK·실행파일은 소스 압축본에 포함하지 않는다.

**다음 작업:** gate 0B를 유지하며 입력과 프레임 갱신 주기의 병목을 좁힌다. 현재 결과로 60fps나 물리 지연 합격을 선언하지 않는다. Windows·실무 코퍼스·읽을 수 있는 대량 문자·물리 포인터 지연은 별도 검증이 필요하다.
