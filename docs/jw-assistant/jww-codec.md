# JWW 순수 JS 코덱

2026-10-01. 구현: `addons/jw-assistant/native/codec/`, 테스트: `tests/jww-codec.test.mjs`, 감사 CLI: `tools/codec-audit.mjs`.
Node 22+, npm 의존성 없음. 필드 순서는 [JinkiKeikaku/JwwExchange](https://github.com/JinkiKeikaku/JwwExchange)(Unlicense)의 `CJwwHeader::Read`·`CData*::Serialize`와 MFC TN002를 참고해 직접 구현했다.

## API

```js
import { decodeJww, encodeJww, semanticView, createJww } from './native/codec/jww-codec.mjs';
import { applyOps } from './native/codec/jww-ops.mjs';
const doc = decodeJww(bytes);               // 편집 가능한 문서
encodeJww(doc).equals(bytes);               // true (코퍼스 전체)
semanticView(doc);                          // {layers, entities[{id,kind,type,layer,pen,geometry}], blocks[{...children}], images, diagnostics}
const { doc: next, idMap } = applyOps(doc, validatePatchV2(patch, ir).ops);
```

- `archive.mjs`: CArchive `Reader`/`Writer`(태그·PID 표), CString, CP932 인코더.
- `jww-schema.mjs`: 헤더·엔티티 필드 배치를 선언형으로 기술. 읽기/쓰기가 같은 표를 해석한다.
- `jww-ops.mjs`: `translateEntity`, `deleteEntities`, `modifyEntity`, `setEntityLayer`, `setEntityPen`, `appendEntity`, `makeEntity`, `cloneDoc`, `applyOps`.
- `compare.mjs`: `compareWithNative(doc, readJwwResult)` — DLL 판독기와 의미 대조.
- 오류 코드: `E_JWW_FORMAT|HEADER|TRUNCATED|TAG|UNKNOWN_CLASS|UNSUPPORTED_TAG|FIELD|CODEC_PARTIAL`, `E_CODEC_ENTITY|KIND|LAYER|SCALE|PEN|MODIFY_FIELD|SETLAYER_SCALE|VALUE|TEMP_ID|OP`.

## 코퍼스에서 확인한 형식 (증거 오프셋)

| 항목 | 내용 | 증거 |
|---|---|---|
| 서명·버전 | `JwwData.` + DWORD | Test1 @8 = `58 02 00 00`(600), 腹部研修 @8 = 700 |
| 헤더 | jwdatafmt 순서 그대로, 버전 분기(300/351/420 등)는 헤더 버전 기준 | Test1 헤더 [8,14542), 腹部研修 [8,16560) |
| CString(ANSI) | 길이 BYTE / `FF`+WORD / `FF FF FF`+DWORD, 본문 CP932 | Test1 메모 @12 `24 93 fa …`(36바이트) |
| CString(Unicode) | `FF FE FF` + 길이(UTF-16 단위) + UTF-16LE | 腹部研修 레이어명 `芝` = `fffeff01 9d82`; 研修 메모 `fffeff02 0d00 0a00` |
| 엔티티 목록 | `CObList::Serialize`: WORD 개수(≥0xFFFF면 `FFFF`+DWORD) 후 객체 | Test1 @14542 = 1686, 腹部研修 @16560 = 21209 |
| 새 클래스 태그 | `FFFF` + schema WORD + 이름 길이 WORD + ASCII | Test1 @14544 `ffff 5802 0800 CDataSen`(schema 600), 腹部研修 schema `bc02`=700 |
| 기존 클래스 태그 | `0x8000\|PID`, PID는 클래스·객체 공용 카운터(1부터) | Test1 e1 @14605 `01 80`; 研修 e2 @16761 `03 80`(CDataMoji=1, 객체=2, CDataSen=3) |
| 큰 PID | `7FFF` + DWORD(클래스면 `0x80000000\|PID`) | 합성 0x8011 객체 파일 → 코덱 왕복 + DLL 판독 일치 |
| CDataTen | 선종 100일 때만 기호 필드 | 코퍼스 점은 모두 선종 1; Test1 e80 = 새 태그 14 + 공통 15 + 좌표 16 + DWORD 4 = 49바이트 |
| CDataSolid | 선색 10일 때만 RGB DWORD | 腹部研修 e14166 = 새 태그 16 + 공통 15 + 좌표 64 + RGB 4 = 99바이트 |
| CDataSunpou | 버전 ≥420이면 `WORD m_bSxfMode` + 보조선 2 + 점 4 | 코퍼스에 치수 없음 → 합성 테스트만 |
| 블록 정의 | `CDataList`: 공통헤더 + INT 번호 + BOOL 참조 + **CTime=DWORD(32bit time_t)** + 이름 + 하위 목록 | 腹部研修 b0 @1139730, m_time=1716210796(2024-05-20) |
| 이미지(v700+) | DWORD 개수 + (CString 이름, DWORD 크기, 바이트) | 腹部研修·研修 끝 4바이트 `00000000`(이미지 0개) |
| m_sFlg | WORD. DLL은 Int16으로 노출(부호만 다름) | Test6 등 0x8000 이상 값 |

## 무엇이 바이트 정확한가

- **왕복**: 모든 필드를 레코드에서 재직렬화한다(원본 복사가 아님). 문자열은 원본 바이트(길이 접두 형태·ANSI/Unicode 구분 포함)를 보존하고 값이 바뀐 경우만 재인코딩, NaN double은 원래 8바이트 유지, 클래스 태그/PID는 MFC 규칙대로 재생성. 후행 미지 바이트는 `doc.trailer`로 보존.
- **코퍼스 결과(2026-10-01)**: `C:/JWW` 하위 `.jww` 22개 전부 decode→encode 바이트 동일, DLL 의미 대조 22/22 일치. `.BAK`·`.jw$` 포함 32개도 전부 동일.

| 파일 | ver | 왕복 | 의미 대조 |
|---|---|---|---|
| APW430_1, 無題, kadai/muzai1, RC集合住宅, 【自動保存】RC集合住宅.jw$.JWW, 腹部研修 | 700 | ok | ok |
| kadai/研修 | 700 | ok | ok (DLL이 `㎆` 3건을 `?`로 손실 — 우리 쪽이 정확) |
| Test1–7, サンプル, 天空率表, 敷地図, 日影図, 木造平面例, Ａマンション25d/平面例/立面例 | 600 | ok | ok |

- **편집 후**: 손대지 않은 레코드의 필드 바이트는 그대로다. 단, 구조 변경(삭제·추가) 뒤에는 MFC가 요구하는 대로 목록 개수 WORD와 이후 레코드의 클래스 참조 태그(`0x8000|PID`)가 재번호된다. 어떤 클래스를 처음 정의하던 레코드를 지우면 다음 같은 클래스 레코드가 `FFFF` 정의를 넘겨받는다. 이동(translate)만 하면 해당 선의 좌표 32바이트만 바뀐다(테스트로 검증).

## 문자열 인코딩 정책

- 디코드: ANSI는 `TextDecoder('shift_jis')`(WHATWG = CP932 확장 포함), Unicode는 UTF-16LE.
- 인코드: 바뀌지 않은 문자열은 원본 바이트. 새·변경 문자열은 원래 필드가 Unicode였으면 Unicode, 새 엔티티는 도면의 문자 대다수 관례(`doc.stringEncoding`)를 따른다. CP932는 디코더 역표를 한 번 만들어 캐시(ED/EE행은 마지막에 방문해 `纊`→`FA5C`, `∵`→`81E6`, `￢`→`81CA`). CP932로 표현 불가한 문자(`㎆`, `¥` 등)는 Unicode CString으로 대체.

## 변경 연산 (`applyOps`, Patch v2 정규화 결과 입력)

좌표는 모델 mm ÷ 그룹 축척 = 파일 좌표, 문자 크기는 용지 mm(=파일 단위), 각도는 도.

| op | 지원 | 비고 |
|---|---|---|
| translate | 선·원호·점·문자·솔리드·블록삽입·치수(보조부 포함) | |
| delete | 모든 최상위 엔티티 | |
| modify | 선 start/end, 문자 at/text/height/width/angle, 원호 center/radius/startAngle/sweepAngle, 점 at | 문자 끝점은 `전각=폭, 반각=폭/2, +간격×(n−1)`으로 재계산(코퍼스 93% 일치, 근사) |
| add | line/text/arc/point, 목록 끝에 추가 | 문자: style 1–10은 헤더 문자종 크기·색, 글꼴은 도면 최빈값 |
| setLayer | 모든 최상위 엔티티 | 그룹 축척이 다르면 모델 mm 유지하도록 좌표 재스케일, 블록·치수는 `E_CODEC_SETLAYER_SCALE` |
| setPen | 선·원호·점·솔리드(문자는 color만) | 점 선종 100 전환·솔리드 색 10 전환은 레이아웃이 바뀌므로 거부 |

검증: 각 결과를 재디코드·재인코드(동일)하고, DLL `readJww`로 열어 `compareWithNative` 일치 + 변경값 확인(Test1, 腹部研修).

## 한계

- 코퍼스에 치수(CDataSunpou), 선종 100 점, 이미지 실데이터, 0xFFFF 초과 개수가 없다 → 합성 테스트로만 검증.
- 객체 역참조 태그(같은 객체 재기록)·NULL 객체·미지 클래스는 미지원: 원본을 `doc.passthrough`로 그대로 내보내고(`doc.partial`, `PARTIAL_DECODE` 진단) 편집은 `E_JWW_CODEC_PARTIAL`로 거부.
- 버전 <300 분기는 표에 있으나 코퍼스 검증 없음. 블록 정의 내부 엔티티 편집, 레이어명·헤더 편집 API는 아직 없음.
- Jw_cad 본체에서 편집 결과를 실제로 열어 보는 시각 검증은 하지 않았다(검증 기준은 JwwHelper DLL). 구 Jw_cad가 Unicode CString을 읽는지도 미확인.
