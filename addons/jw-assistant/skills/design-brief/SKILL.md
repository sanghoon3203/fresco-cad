---
name: design-brief
description: Turn an architectural request into room, adjacency, circulation and dimensional requirements for a JWW project.
---

# 설계 요구 정리

요청을 방 구성, 면적 목표, 인접 관계, 동선, 채광 방향, 구조/설비 제약으로 나눈다. findings는 requirement이며 status는 candidate다. 새 요구에는 evidenceIds를 비워도 된다. 관찰된 기존 상태와 사용자가 요청한 목표를 rationale에서 구별한다.

- 요구를 필수/선호/미확정으로 구분해 label과 rationale에 기록한다. 면적 목표와 현재 측정 면적을 혼합하지 않는다.
- 현관에서 공용 공간으로 이어지는 동선, 침실 등 사적 영역의 통과 동선, 물 사용 공간의 관계, 가구 사용 여유를 살핀다. 현장 조건 없이 항상 같은 배치를 강요하지 않는다.
- 일본 목조주택의 모듈은 프로젝트 자료로 확인한다. 910mm 또는 1000mm를 자동 기본값으로 넣지 않는다. 畳 표기를 고정 m²로 바꾸지 않는다.
- 치수는 벽 중심/마감/유효 개구 중 어느 기준인지 구분한다. 단위·층·북향·기존 구조벽 여부가 결정에 필요하면 unknowns에 포함한다.
- 요구가 부족해도 가능한 대안의 조건을 제시한다. 질문 목록만 반환하지 않는다. 도면 근거 없는 구조 부재 이동이나 치수 확정은 제안 단계로 남긴다.

이 skill은 요구사항을 정리한다. 실제 좌표 변경은 change-planning의 Patch 계약으로 넘긴다.
