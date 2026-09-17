# 라이선스·보안 위험표

확인일: **2026-09-10**. 상태: Phase 0 조사 완료, 회사 승인·배포 심사·통합 보안 테스트는 미완료. 아래 버전은 공개 자료에서 확인한 **검토 후보**이며 사내 사용 승인을 뜻하지 않는다. 이 조사에서 OpenMAIC, Archify, SEED 코드나 자산을 제품에 포함하거나 실행하지 않았다.

## Qt 기준선

Qt 공식 릴리스 표에서 공개 일반 계열은 **6.11.2**, LTS 계열은 **6.8.8**이다. 6.8.8은 상용 고객용 추가 LTS 패치로 표시되며, 6.8 LTS 표준 상용 지원 종료일은 2029-10-08이다. 공개 초기 6.8 패치를 사용하는 것과 상용 LTS 패치를 계속 받는 것은 별도 결정이다. 로컬 스파이크의 실제 Qt 버전은 빌드 기록을 따른다. 상용 계약·유료 SDK 구매는 아직 하지 않았다. [Qt Releases](https://doc.qt.io/qt-6/qt-releases.html)

| 목표 | Qt 6.8 공식 표의 구성 | 이 제품 검증 상태 |
|---|---|---|
| Apple Silicon macOS | arm64, Xcode 15/macOS 14 SDK 이상; target macOS 12 이상 | 로컬 빌드 기록 범위만 인정 |
| Windows x64 | Windows 10 1809 이상/11, MSVC 2022 또는 Mingw-w64 13.1 | 실제 빌드·패키지·실기기 검증 대기 |
| Windows ARM64 | ARM64, MSVC 2022; ARM64EC 제외 | 실제 네이티브 빌드·패키지·실기기 검증 대기 |

표는 Qt 자체의 지원 구성이지 Fresco CAD의 지원 선언이 아니다. 최신 6.11 표는 macOS 13 이상이므로 공개 버전 스파이크의 최소 OS를 6.8 표에서 그대로 가져오지 않는다. Qt는 패치 중에도 구성 지원을 변경할 수 있고 모듈별 예외가 있다. [Qt 6.8 Supported Platforms](https://doc.qt.io/qt-6.8/supported-platforms.html), [Qt 6.11 Supported Platforms](https://doc.qt.io/qt-6/supported-platforms.html)

공개 Qt를 폐쇄 소스 앱과 사용하는 후보 경로는 LGPLv3 조건을 만족하는 모듈의 동적 링크다. 배포 전에 정확한 모듈·플러그인·전이 의존성별 라이선스, 고지, 라이브러리의 해당 소스 제공/제안, 사용자의 교체·재링크와 실행 권리, 관련 역공학 제한 예외를 법무가 검토해야 한다. 정적 링크를 일반 금지로 단정하지 않지만 이 스파이크의 배포 경로로 선택하지 않는다. 사내 사용이라는 이유만으로 법인 간 전달·협력사 배포 조건까지 자동 면제되었다고 간주하지 않는다. [Qt LGPL obligations](https://www.qt.io/development/open-source-lgpl-obligations)

Qt의 모든 모듈이 LGPL은 아니다. 예를 들어 Qt Virtual Keyboard, Qt Quick Timeline, Qt Graphs는 공개 GPL 목록에 있다. 일본어 IME는 우선 OS 입력 기능으로 검증하고 이러한 모듈을 편의상 추가하지 않는다. Qt 6.8부터 제공되는 SPDX 2.3 SBOM과 정확한 배포 바이너리의 구성 목록을 대조해야 한다. 상용 Qt도 포함된 제3자 코드의 별도 조건을 없애지 않는다. [Qt Licensing](https://doc.qt.io/qt-6/licensing.html)

## 후보 고정값과 라이선스 증거

| 항목 | 확인한 고정값 | 확인한 라이선스·남은 경계 |
|---|---|---|
| OpenMAIC 서비스 | tag `v1.0.1`; commit `f50a25644c9c3893503cf0727ccf613c0ce1e748`; 2026-09-06 릴리스 | 루트 MIT, THU-MAIC 2026 저작권. 제3자 전체 검토 미완료 |
| Archify 내부 도구/서비스 | tag `v2.16.0`; commit `c826e6c3a7abad19c0f3cd1ca57207d54b1ad8de`; 2026-08-30 릴리스 | 루트 MIT, tt-a1i 2026 및 원저작자 Cocoon AI 2025 고지 보존. 생성물에 포함되는 코드·아이콘·폰트도 별도 확인 |
| SEED Design | `dev/TECH.md`를 원리 참고용으로 열람 | 코드·외형·로고·토큰 값 복제 없음. 실행 의존성 없음 |

고정값 근거: [OpenMAIC v1.0.1 release](https://github.com/THU-MAIC/OpenMAIC/releases/tag/v1.0.1), [OpenMAIC commit](https://github.com/THU-MAIC/OpenMAIC/commit/f50a25644c9c3893503cf0727ccf613c0ce1e748), [OpenMAIC LICENSE](https://raw.githubusercontent.com/THU-MAIC/OpenMAIC/v1.0.1/LICENSE), [Archify v2.16.0 release](https://github.com/tt-a1i/archify/releases/tag/v2.16.0), [Archify commit](https://github.com/tt-a1i/archify/commit/c826e6c3a7abad19c0f3cd1ca57207d54b1ad8de), [Archify LICENSE](https://raw.githubusercontent.com/tt-a1i/archify/v2.16.0/LICENSE).

OpenMAIC v1.0.1 소스의 각 package manifest는 다음 버전과 MIT를 선언한다. 이는 **소스 태그의 manifest 확인**이며 npm 배포 tarball·integrity·provenance 검증은 아니다.

| 패키지 | 버전 | 개별 근거 | 추가 검토 |
|---|---|---|---|
| `@openmaic/dsl` | 0.11.1 | [package.json](https://raw.githubusercontent.com/THU-MAIC/OpenMAIC/v1.0.1/packages/@openmaic/dsl/package.json) | 패키지 내 LICENSE 원문, 빌드 도구 |
| `@openmaic/renderer` | 0.1.6 | [package.json](https://raw.githubusercontent.com/THU-MAIC/OpenMAIC/v1.0.1/packages/@openmaic/renderer/package.json) | React 등 peer/transitive packages, `font-licenses`, CSS·번들 자산 |
| `@openmaic/generation` | 0.3.6 | [package.json](https://raw.githubusercontent.com/THU-MAIC/OpenMAIC/v1.0.1/packages/@openmaic/generation/package.json) | 템플릿·프롬프트 자산과 전이 패키지 |
| `@openmaic/storage` | 0.29.0 | [package.json](https://raw.githubusercontent.com/THU-MAIC/OpenMAIC/v1.0.1/packages/@openmaic/storage/package.json) | 선택한 backend/peer packages, 저장 데이터 정책 |

위 네 패키지의 개별 LICENSE 및 renderer FONTS.md 원문 URL은 이번 브라우징에서 `Cache miss`로 가져오지 못했다. 파일이 없거나 루트와 같은 조건이라고 단정하지 않는다. 포함 승인 전에 고정 commit의 실제 소스와 배포 tarball을 비교하여 기록한다. Archify manifest는 MIT, Node >=18, 빌드용 ajv·parse5·saxes·simple-icons를 표시하지만 전이 의존성 전체 감사는 하지 않았다. [Archify package.json](https://raw.githubusercontent.com/tt-a1i/archify/v2.16.0/archify/package.json)

## OpenMAIC 공개 보안 공지

2026-09-06에 공개된 다음 공지를 읽었다. v1.0.1 릴리스는 네 문제의 수정을 설명하므로 1.0.0 이하를 서비스 후보로 쓰지 않는다. 수정 릴리스 채택은 사내 배포 구성에 대한 침투·격리 검증을 대체하지 않는다. [v1.0.1 security release](https://github.com/THU-MAIC/OpenMAIC/releases/tag/v1.0.1)

| 공지 | 공개 심각도 | 사내 재검증 항목 |
|---|---|---|
| [GHSA-9m7h-vh2h-rc3w](https://github.com/THU-MAIC/OpenMAIC/security/advisories/GHSA-9m7h-vh2h-rc3w) | Critical | 모든 실행 환경의 인증 실패 폐쇄, cloud metadata/private address egress 차단 |
| [GHSA-p2wh-m28m-c5xw](https://github.com/THU-MAIC/OpenMAIC/security/advisories/GHSA-p2wh-m28m-c5xw) | High | 저장 경로 탈출 거부, owner별 학습 데이터 격리 |
| [GHSA-7rhf-2798-mvcj](https://github.com/THU-MAIC/OpenMAIC/security/advisories/GHSA-7rhf-2798-mvcj) | High | 저장 HTML 정화, 재열기·번역·가져오기 경로의 XSS |
| [GHSA-725p-44hx-v52c](https://github.com/THU-MAIC/OpenMAIC/security/advisories/GHSA-725p-44hx-v52c) | Moderate | 매 redirect 목적지 검증 및 origin 변경 시 인증 헤더 제거 |

OpenMAIC는 최신 릴리스/main에 보안 수정을 제공한다고 명시한다. 이를 런타임 main 추적 허가로 해석하지 않고, 새 공지가 나오면 새 후보 commit을 별도 검토한다. Archify 보안 페이지에서 공개 공지 항목은 확인하지 못했으며, 구버전 유지보수/백포트는 보장되지 않는다. 공지 미발견은 취약점 없음의 증거가 아니다. [OpenMAIC Security](https://github.com/THU-MAIC/OpenMAIC/security), [Archify Security](https://github.com/tt-a1i/archify/security)

## 최소 위험표와 승인 게이트

| 위험 | 현재 통제/결정 | 출시 또는 기능 활성화 전 증거 | 상태 |
|---|---|---|---|
| Qt LGPL·LTS·코드서명 배포 | 공개 스파이크와 제품 배포 계약 분리; 동적 링크 후보 | 모듈 목록, 정확한 버전/해시, 라이선스·SBOM, 교체 실행 절차 또는 승인된 상용 계약 | 배포 승인 대기 |
| JWW/JWC·DWG 등 형식 권리와 손실 | 외부 코드·SDK 미포함, 추측 파서 금지 | 법무 승인된 사양/SDK, 익명 코퍼스, 원 CAD 재열기·출력 비교 | 미지원 |
| 교육·다이어그램 HTML과 공급망 | 제품 코어와 별도 origin/프로세스 계획; 검토 후보만 기록 | 고정 artifact hash, 의존성/폰트 고지, CSP·egress·XSS·크기/시간 제한 실험 | 통합 미구현 |
| AI 도면 전송·권한 상승 | 공급자 키·실제 도면 전송 없음; 원본 변경은 검증된 command 경로만 허용 | 사내 Gateway, SSO/RBAC, 분류·최소 전송 미리보기, 보존/삭제·비용/감사 정책, injection 테스트 | AI 미구현 |
| 악성 파일·저장 실패·복구 | 내부 형식의 trust boundary부터 제한; 서명 배포 전까지 개발용 표시 | NaN/Inf·과대 입력·손상·재귀 테스트, 원자 저장/복구, 서명·rollback 훈련 | 각 로컬 시험 결과만 인정 |

배포할 실제 구성의 SBOM·NOTICE·취약점 스캔 결과는 아직 생성하지 않았다. 다음 라이선스 작업은 **스파이크에서 실제 사용한 Qt 모듈과 바이너리 목록을 추출하여 이 표와 대조**하는 것이다.
