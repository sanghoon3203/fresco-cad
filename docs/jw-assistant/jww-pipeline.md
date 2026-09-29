# JWW JSON 편집 CLI — P1 구현

현재 inspect 출력은 IR schemaVersion 2다. 블록 정의·배치·내부 객체와 건축 스킬 연결 계약은 [구조 JSON과 스킬 프레임워크](architecture-skills.md)를 참고한다. 수정 Patch는 기존 schemaVersion 1을 유지한다.

2026-09-29. 기존 작업 트리의 JwwHelper reader/좌표 patch를 재사용해 `inspect → JSON Patch → apply → 재파싱 → 새 파일` 경로를 추가했다. 전체 JWW 재직렬화 writer가 아닌 원본 보존형 선 편집 구현이다.

## 사용

`addons/jw-assistant` 디렉터리에서 Node와 Windows x64로 실행한다. 출력 파일은 새 경로여야 한다.

```powershell
node tools/jww-cli.mjs inspect C:/JWW/Test1.jww drawing.json
```

JSON의 `editable: true`인 객체 ID와 `sourceHash`를 사용해 다음 patch.json을 작성한다.

```json
{
  "schemaVersion": 1,
  "sourceHash": "inspect에서 받은 SHA-256",
  "op": "TranslateEntities",
  "ids": ["e0"],
  "dx": 910,
  "dy": 0,
  "units": "model-mm"
}
```

```powershell
node tools/jww-cli.mjs apply C:/JWW/Test1.jww patch.json moved.jww
```

`dx/dy`는 도면 XY축의 모델 mm다. 그룹 축척으로 나눠 파일 좌표에 적용한다. UI 회전축이나 벽 방향에 따른 상대 이동은 아니다. 객체 ID는 해당 입력 해시에만 유효하며 다른 파일의 ID로 재사용하지 않는다.

## 구현 범위

- 여러 일반 선의 평행 이동(최대 100개), 각 그룹 축척 적용.
- 원본에서 모든 위치를 먼저 결정해 겹치지 않는 좌표 구간만 변경.
- 입력 해시, 단위, 대상 ID와 유한 수치 검증; 원본 및 기존 출력 덮어쓰기 거부.
- 수정 후 native reader로 다시 읽어 예상 객체/속성과 대조한 뒤 출력.
- JSON에는 편집 가능 여부를 표시하며 원본 복원용 record는 AI 문맥에서 제외.
- 일반 점의 미저장 symbol 속성을 읽던 기존 reader 문제 수정. 근거는 upstream `CDataTen::Serialize`: pen style 100에서만 해당 세 필드를 저장한다.

문자·치수·블록 편집, 도형 추가/삭제, 범용 writer, 자연어 편집 호출과 UI 연결은 이번 구현 범위에 포함되지 않는다. 현재 byte-match 기반 위치 결정은 유일한 일반 선만 허용한다. 파일 구조를 전부 해석한 offset parser로 대체하는 것은 후속 확장이다.

## 검증

- 자동 테스트 81개 통과(당시 전체 suite; 이후 native 선택 실행 테스트 추가).
- 추가한 실제 파일 회귀도 통과: 반복 읽기 일치, 무변경 patch 바이트 일치, 이동량, 좌표 외 바이트 보존, 원본 불변.
- `C:/JWW/Test1.jww`: 1,686개 top-level 객체, 편집 가능 일반 선 42개.
- `e0`를 모델 X축으로 910mm 이동한 출력은 native 재파싱과 객체 대조 통과.
- 입력 SHA-256: `de0ecf5991bbf7b66388a3837af2a2318e56eac175592c3e48e608c85d2c16b2`.
- 출력 SHA-256: `36cf38efe7ad82772e11533e781281a2ce24a4d0d21f0c86d909deee0723e240`.
- 샘플 결과는 상위 작업 공간 `outputs/jww-pipeline-demo/`에 보관했다. 원본 샘플은 수정하지 않았다.
- Jw_cad GUI 재개방은 파일 선택창 자동 입력 문제로 미완료. native 재파싱을 Jw_cad 시각 검증으로 표시하지 않는다.

재현 가능한 실제 파일 회귀:

```powershell
$env:FRESCO_JWW_FIXTURE = 'C:/JWW/Test1.jww'
node --test tests/jww-native.test.mjs
```

위 회귀는 같은 파일의 두 번 읽기 일치, 무변경 patch 바이트 일치, 910mm 이동, 좌표 외 바이트 보존, 입력 불변을 검사한다. 무변경 patch 성공은 전체 재직렬화 왕복 성공을 의미하지 않는다.
