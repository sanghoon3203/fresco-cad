---
name: drawing-reading
description: Interpret selected JWW entities and block instances as architectural object candidates with drawing evidence.
---

# JWW 도면 읽기

입력 packet의 객체와 블록 배치에서 벽, 기둥, 문, 창, 계단, 설비, 주석 후보를 찾아 findings로 반환한다. sourceHash와 객체 경로를 근거로 사용한다.

- 먼저 문자·치수·레이어명·블록명과 형상을 함께 대조한다. 숫자 레이어나 블록 개수만으로 용도를 정하지 않는다.
- 두 평행선은 벽의 후보일 뿐이다. 연결된 코너, 개구부, 두께의 일관성, 주변 실명 중 어떤 근거가 있는지 적는다. 단일 선을 중심선/벽 마감선으로 임의 확정하지 않는다.
- 문 후보는 문짝과 회전 호, 벽 개구부, 건구 기호의 일치를 살핀다. 호가 있다는 이유만으로 문으로 확정하지 않는다. 반전된 블록의 열림 방향은 transformToModel을 적용한 위치로 판단한다.
- 창 후보는 벽과의 연결 및 창호 기호를 함께 확인한다. 블록 정의는 재사용 부품이고 각 배치는 별개다. 같은 정의의 여러 배치를 하나의 창으로 합치지 않는다.
- 방은 닫힌 경계와 실명으로 후보를 만든다. 도면 틀, 해칭, 가구의 닫힌 외곽을 방으로 세지 않는다. 층·도면 종류가 불명확하면 unknowns에 남긴다.
- local geometry와 모델 mm를 구분한다. 일반 객체는 group scale, 블록은 제공된 누적 matrix를 사용한다. 이미 변환된 modelPoints에 축척을 다시 곱하지 않는다.

각 finding의 kind는 architectural-candidate, status는 candidate다. evidenceIds에는 packet에 있는 객체 path/id만 넣는다. label에는 예상 용도, rationale에는 형상·문자 근거와 대안 해석을 적는다. parser 경고 때문에 보이지 않는 객체는 없는 것으로 판단하지 않는다.
