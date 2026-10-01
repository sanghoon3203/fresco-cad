# Patch v2 — AI 편집 명령 계약

2026-10-01. 구현: `addons/jw-assistant/core/patch-v2.mjs`, 테스트: `tests/patch-v2.test.mjs`. v1(`TranslateEntities` 단일 명령)은 기존 경로 호환용으로 유지한다.

AI(Claude/OpenAI)는 바이너리나 전체 IR을 생성하지 않는다. 이 계약의 JSON만 반환하고, 프로그램이 검증·적용·재파싱한다.

## 단위와 좌표

- 좌표·길이: **모델 mm**, 도면 XY축(Y-up). 엔진이 레이어 그룹 축척으로 나눠 파일 좌표로 변환한다.
- 문자 크기·간격: **용지 mm**(Jw_cad 관례). 축척과 무관.
- 각도: 도(degree), 반시계 방향 양수.
- 레이어: `"G:L"` 16진 한 자리씩(`"0:3"` = 0그룹 3레이어). IR의 `layers`에 있는 값만 허용.

## 루트

```json
{ "schemaVersion": 2, "sourceHash": "<IR의 sourceHash>", "units": "model-mm",
  "ops": [ ... ], "rationale": "변경 이유", "needsClarification": null }
```

모호한 지시는 `ops: []`와 `needsClarification: "질문"`으로 답한다. 추측으로 편집하지 않는다.

## 명령

| op | 필드 | 대상 |
|---|---|---|
| `add` | `tempId`(`n0`… 또는 null), `entity` | line / text / arc / point |
| `delete` | `ids` | 모든 최상위 객체 |
| `translate` | `ids`, `dx`, `dy` | 모든 최상위 객체(엔진이 미지원 종류는 거부) |
| `modify` | `id`, `set` | 종류별 기하·문자 필드 |
| `setLayer` | `ids`, `layer` | 모든 최상위 객체 |
| `setPen` | `ids`, `pen{color,style,width}` | 선·원호·점(문자는 color만) |

엔티티:

- line `{kind, layer, start:[x,y], end:[x,y], pen}`
- text `{kind, layer, at, text, height, width, spacing, angle, style, color}` — style은 Jw 문자종류 1–10, null 필드는 도면 기본값.
- arc `{kind, layer, center, radius, startAngle, sweepAngle(±360=원), flatness(1=정원), tilt, pen}`
- point `{kind, layer, at, pen}`

`modify.set`의 모든 필드는 nullable이며 null이 아닌 필드만 적용한다. strict structured output을 위해 모든 키를 반드시 포함한다.

## 검증 규칙 (`validatePatchV2`)

- sourceHash 불일치 → `E_PATCH_STALE`. 다른 파일의 ID 재사용 금지.
- 없는 ID → `E_PATCH_ENTITY`, 삭제 후 참조 → `E_PATCH_DELETED_TARGET`, 없는 레이어 → `E_PATCH_LAYER`.
- 비유한 값·범위 초과 → `E_PATCH_VALUE`, 길이 0 선 → `E_PATCH_ZERO_LENGTH`, 빈 명령 → `E_PATCH_EMPTY`.
- 최대 200 ops, ID 참조 합계 500.
- 오류의 `.detail`은 `ops[2].ids[0]=e9` 같은 경로다. 재시도 프롬프트에 그대로 넣어 모델이 고치게 한다.

구조 검증 통과는 편집 의도의 정답을 뜻하지 않는다. 적용 엔진의 재파싱 대조와 평가 세트의 의미 검사가 별도로 필요하다.
