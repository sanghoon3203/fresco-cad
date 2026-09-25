# Jw Assistant — 디자인 적용 기록

작성 2026-09-23. 이번 결과는 HTML/SVG 시제품이며 SEED React 라이브러리를 설치한 제품이 아니다.

## 읽고 적용한 GitHub skills

| Skill | 출처 / 고정 커밋 | 라이선스 | 실제 적용 |
|---|---|---|---|
| SEED Design | [당근 공식](https://github.com/daangn/seed-design/tree/ff8836c082d20e601eb58aea07270c5b0f98ece1/skills/seed-design), `ff8836c082d20e601eb58aea07270c5b0f98ece1` | Apache-2.0 | 공식 Foundations 문서 라우팅, 의미별 색·간격·텍스트 위계, 소비자/플랫폼 구분 |
| Apple Liquid Glass | [커뮤니티 skill](https://github.com/naplesblue/apple-design-skill/tree/e81692da299d64b9bf38ae26db2d709fc60c8bf3), `e81692da299d64b9bf38ae26db2d709fc60c8bf3` | MIT (저장소 고지 참조) | 절제된 패널, 상태 피드백, 취소·되돌림, 축소 모션, 키보드 경로 |

보관 위치는 `tools/skills/seed-design`과 `tools/skills/apple-design`이다. skill-installer로 고정 커밋을 내려받아 이번 작업에서 직접 읽었다. **프로젝트 안에 보관한 스킬이며 전역 스킬 목록에 자동 등록한 것은 아니다.** 다음 작업도 해당 SKILL.md를 읽어 재사용할 수 있다. 라이선스 원문과 provenance를 함께 보관한다.

SEED 공식 인덱스: [전체](https://seed-design.io/llms.txt), [Foundations](https://seed-design.io/foundations/llms.txt). 플랫폼이 정해지기 전 React의 토큰 API를 추측해 적용하지 않는다. 설치형 React 단계에서 공식 컴포넌트·CSS 패키지의 일치하는 버전을 lock한다.

구현 담당자가 실제 읽은 leaf 문서: [색 역할](https://seed-design.io/llms/foundations/color/color-role.txt), [포용적 설계](https://seed-design.io/llms/foundations/inclusive-design.txt), [국제화](https://seed-design.io/llms/foundations/international-design.txt), [레이아웃](https://seed-design.io/llms/foundations/layout.txt), [피드백](https://seed-design.io/llms/foundations/feedback.txt), [상태](https://seed-design.io/llms/foundations/state.txt), [타이포그래피](https://seed-design.io/llms/foundations/typography.txt).

Apple 보조 스킬은 Apple의 공식 배포물이 아니다. 사용자가 요청한 **SEED 디자인과 Apple식 인터랙션**을 조합하기 위해 상충하는 iPhone 프레임·SF 글꼴·강제 파란색 팔레트·과도한 blur는 채택하지 않는다. Windows용 Segoe/Yu Gothic/Meiryo 계열 시스템 글꼴을 사용한다. 이 우선순위는 사용자 요청을 따른 것이다.

## 화면·동작 계약

- 주 화면: 경고 목록 → 도면 preview → 측정 근거/수정 대상. 채팅은 첫 화면 중심 기능이 아니다.
- 위계: 문제가 무엇인지, 실제로 어디인지, 수정으로 무엇이 사라지는지 순서대로 읽힌다.
- preview: 삭제 선을 색과 패턴으로 구분하며 확정 전 모델은 바뀌지 않는다. 정밀 도형 위치는 애니메이션하지 않는다.
- 안전한 수정: 경고형·수정 가능을 구분한다. 버튼은 “데모에 적용”처럼 대상과 범위를 드러낸다.
- 상태: 로딩·오류·빈 결과·preview·적용·취소·Undo와 연결되지 않은 Jw/AI를 사실대로 표시한다.
- 접근성: 기본 HTML controls, focus 가시성, 상태 live region, Esc 취소, Tab 경로, OS와 사용자 축소 모션 설정.
- 언어: ja-JP / en-US 전체 메시지 catalog. 도면 데이터, mm, rule/entity ID는 안정적으로 유지하고 사용자용 제목·설명은 번역한다.
- 정보 밀도: CAD 작업용 3열을 우선하되 좁은 창에서는 순차 배치. 긴 영문·일문·ID 때문에 가로 overflow가 생기지 않아야 한다.

SEED 적용 여부를 색상 유사성만으로 판정하지 않는다. 이번 CSS의 `--sky`, `--surface`, `--focus` 등 제품용 토큰은 독립 정의이며 공식 SEED 토큰 API라고 표시하지 않는다. SEED 패키지·디자인 전체 준수 또는 접근성 인증을 주장하지 않는다.

## 검증 기준

2026-09-24 계획 확장: [사무소 온보딩 UX](office-onboarding-ux.md)에 로컬 시작·프로필 보정·coverage·수정 지시의 원문 대조·BYOK·비용·오류 처리와 ja/en 문구를 정의했다. 현재 HTML 시제품에 이 화면들이 구현된 것은 아니다. 디자인의 다음 우선순위는 검사 범위와 검토 상태의 구별, 원문과 AI 초안의 나란한 검토, 키 설정 없이 시작하는 경로다.

브라우저의 실제 동작과 화면은 스프린트 보고서에 남긴다. 일본어/영어 전환과 재로드, 1280px·640px·좁은 패널, focus/취소, preview→apply→undo, export 상태를 확인한다. Windows Narrator·일본어 IME·네이티브 shell은 이후 실기 검증 대상이다. 규칙 엔진 시험과 UI 접근성/디자인 검증은 서로 대체하지 않는다.
