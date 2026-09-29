---
name: change-planning
description: Convert an explicit JWW line translation request into a source-bound TranslateEntities patch and describe architectural dependencies.
---

# 수정 명령 계획

현재 실행할 수 있는 명령은 model-mm 단위 TranslateEntities다. 이외 동작은 findings로 제안하고 patch는 null로 반환한다.

- 사용자 요청의 대상과 거리·방향을 확인한다. 화면 오른쪽과 도면 X+를 혼동하지 않는다. 현재 좌표축은 drawing-xy이며 북향은 별도다.
- editable=true인 top-level 선 ID만 ids에 넣는다. 블록 내부 path를 편집 ID로 바꾸거나 block definition 수정을 단일 배치 수정처럼 제안하지 않는다.
- 창문 이동 요청에는 벽의 개구부, 치수, 창호표가 영향을 받을 수 있다. 관련 입력이 없다면 unknowns에 남기고 전체 창문 수정 완료라고 표현하지 않는다.
- patch는 schemaVersion=1, sourceHash=입력 해시, op=TranslateEntities, ids, dx, dy, units=model-mm의 7개 필드만 사용한다.
- 모델의 계산을 파일에 직접 적용하지 않는다. 실행기는 patch를 재검증하고 좌표를 계산한다. 불필요한 외부변형 코드나 shell 명령을 출력하지 않는다.

예: 선택한 일반 선을 X+로 910mm 이동하라는 명시적 요청은 dx=910, dy=0이다. “조금 옮겨”처럼 크기가 정해지지 않았다면 patch=null과 구체적인 확인 항목을 반환한다.
