# JWW 편집 엔진 (Patch v2 → JWW)

2026-10-02. 구현: `addons/jw-assistant/native/jww-edit.mjs`, 검증: `native/verify.mjs`, DLL 워커: `native/jww-worker.mjs` + `native/Jww-Worker.ps1`.
테스트: `tests/jww-edit.test.mjs`, `tests/verify.test.mjs`. 검증 단계의 상세는 [verification.md](verification.md).

## API

```js
import { applyPatchV2, finalizePatchV2 } from './native/jww-edit.mjs';
// 미리보기: L1+L2 (DLL 호출 없음)
const preview = await applyPatchV2(bytes, patch, { ir, level: 'preview' });
// 저장: L1+L2+L3 (기본값). 미리보기 바이트를 저장 전에 재검증하려면:
const saved = await finalizePatchV2(bytes, patch, preview.bytes, { ir, document });
saved.receipt.verification; // [{ level:'L1'|'L2'|'L3', ok, durationMs, checks:[{id, ok, detail}] }]
```

- `level`: `'preview'`(L1+L2) | `'save'`(L1+L2+L3, 기본값). `receipt.level`, `receipt.verifiedLevels`, `receipt.finalized`(save일 때만 true).
- `writer`: `'codec'`(기본값, 순수 JS. 건드리지 않은 바이트 유지) | `'dll'`(JwwHelper 전체 재작성. 바이트 동일성이 없으므로 L2 대신 항상 L3를 실행).
- `document`: DLL 판독 결과(`readJww`). save 단계에서 L3의 기준 상태 계획에 쓴다. 없으면 워커로 읽는다.
- 실패하면 `error.code`는 기존 코드(`E_PATCH_*`, `E_JWW_TEXT_CHAR`, `E_JWW_EDIT_VERIFY` 등)를 그대로 유지하고, `error.verification`에 실행된 단계의 결과가, `error.level`에 실패한 단계가 들어간다.
- 반환되는 `ir`은 출력의 코덱 뷰(`codecDocument`)로 만든다(DLL 호출 없음). DLL 판독 결과와의 차이는 두 가지다. 비 CP932 Unicode 문자열이 DLL에서는 `?`로 바뀌는 점, 그리고 v600 파일을 DLL은 `version 700`으로 보고하지만 코덱은 실제 600을 보고하는 점이다.

## 계획 (planNativeOps)

model-mm 단위의 정규화된 op를 파일 좌표(그룹 축척으로 나눔)의 네이티브 op와 기대 문서(`expected[]`: `from`, `type`, `props`, `touched`, `endApprox`)로 변환한다. 이 계획은 코덱 쓰기와 독립적으로 계산되며, L2(코덱 뷰)와 L3(DLL 뷰) 모두 이 계획과 비교한다.

텍스트 끝점은 Jw_cad 규칙의 근사값이다. 허용 범위는 반각 문자 간격 절반 규칙과 균일 간격 규칙 사이로, 두 값의 **min~max**를 쓴다. 문자 간격이 음수(예: `-0.3`)이면 균일 간격 쪽이 더 짧아지는데, 이전 구현은 이 경우를 고려하지 않아 "native blocks" 테스트가 실패했다.

## DLL 판독기

`readJww`와 `readHeader`는 상주 워커를 먼저 쓰고, 워커 자체에 장애가 있을 때(타임아웃, 크래시, 시작 실패, 쿨다운, 큐 포화)에만 1회성 PowerShell 판독기(`readJwwOneShot`, `Write-Jww.ps1 -Mode Header`)로 폴백한다. 파일 자체의 판독 오류는 재시도하지 않는다. `FRESCO_JWW_WORKER=0`이면 항상 1회성 경로를 쓴다. 코퍼스 22개 파일에서 워커와 1회성 판독기의 출력(문서와 헤더)은 deep-equal로 일치한다.
