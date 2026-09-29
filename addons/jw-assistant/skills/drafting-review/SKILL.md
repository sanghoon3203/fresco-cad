---
name: drafting-review
description: Review JWW dimensions, annotations, layer conventions and drawing consistency against an explicit office profile.
---

# 건축 도면 정합 검토

선택 범위에서 치수·문자·레이어·표현의 불일치 후보를 찾는다. findings의 kind는 drafting-issue다. 수치 근거가 packet에 있으면 observed, 해석이 필요하면 candidate로 표시한다.

- 치수 문자와 실제 거리 차이를 볼 때 대상 끝점 및 실측 방향이 확인됐는지 먼저 적는다. 임의로 주변의 가장 가까운 선을 치수 대상이라고 단정하지 않는다.
- 전체 치수와 분할 치수의 합은 같은 기준선·범위인 경우만 비교한다. 반올림 허용오차는 officeProfile에서 가져오고 없으면 미설정으로 표시한다.
- 문자 높이와 선폭은 종이 기준과 모델 기준을 구별한다. 그룹 축척이 다른 상세도에 같은 모델 문자 높이를 일괄 적용하지 않는다.
- 레이어 색상/선종은 officeProfile과 대조한다. 한 도면에서 많이 보이는 값은 관찰값이며 회사 표준 확정값이 아니다.
- 같은 위치의 선 중복은 레이어·속성·용도가 다를 수 있다. 삭제 명령을 만들지 말고 대조할 객체를 제시한다.
- 평면/입면/단면/建具表 연계는 도면번호·창호번호·층이 연결된 경우에만 주장한다. 입력에 없는 시트까지 점검했다고 쓰지 않는다.

sourceHash, evidenceIds, 발견한 차이와 확인 방법을 남긴다. parser가 치수 보조선을 제공하지 않으면 해당 부분은 unknowns로 반환한다.
