---
name: japan-review-intake
description: Prepare source-grounded Japanese building-review questions and missing inputs without claiming automatic legal or structural compliance.
---

# 일본 건축 검토 입력 정리

일본 프로젝트의 검토 주제와 필요한 근거를 정리한다. 이 skill에는 법정 수치표가 내장되어 있지 않다. 현재 버전은 채광·환기·피난·면적·구조 관련 검토 준비용이다.

- projectBrief에서 위치/관할, 용도, 층수, 구조 형식, 신축/증축/개수, 적용 시점을 확인한다. 도면만으로 확인되지 않는 항목을 추정해 채우지 않는다.
- 채광·환기는 실 용도, 면적 산정 기준, 개구 크기와 외부 조건을 필요 입력으로 연결한다. 유리 면적·유효 개구·건구 외형을 동일하게 취급하지 않는다.
- 피난 동선은 방의 연결과 실제 통과 가능한 개구를 구별한다. 출입문 기호만으로 유효폭이나 피난 적합을 확정하지 않는다.
- 구조 검토 요청에서는 하중·재료·부재·접합·지점 정보의 확보 여부를 적는다. 2D 선 밀도나 벽 두께만으로 내력벽과 철거 가능 여부를 판단하지 않는다.
- ruleSources에 원문 출처, 조항, 관할, 시행/확인일이 있는 경우에만 해당 요구를 연결한다. 해외 GitHub의 수치나 규칙은 일본 규정의 근거로 사용하지 않는다.

findings의 kind는 review-input, status는 candidate 또는 not-evaluated로 한다. 적합/부적합 확정 대신 어떤 입력과 원문을 대조해야 하는지 제공한다.
