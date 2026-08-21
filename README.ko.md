# OpenCode Durable Memory

OpenCode 코딩 에이전트를 위한 로컬 우선 영속 메모리. 디스크에 그대로 놓인 Markdown, 결정적 BM25F recall, 저장한 내용을 조용히 다시 쓰지 못하는 curation.

[English](README.md) | [한국어](README.ko.md)

이 plugin은 session이 끝나도 남는 메모리를 OpenCode에 제공한다. 메모리 하나는 `${XDG_CONFIG_HOME:-~/.config}/opencode/memory/` 아래의 사람이 읽을 수 있는 Markdown 파일 하나다. system prompt에는 압축된 포인터 색인만 주입되고 본문은 도구가 읽을 때까지 디스크에 남아 있어서, 쓰이지 않는 메모리가 context를 잡아먹지 않는다. 전역 메모리와 작업 공간별 프로젝트 메모리는 서로 다른 저장소에 있다. 데이터베이스, 임베딩 모델, API 키, 읽기 경로의 네트워크 호출이 모두 없다.

## 이 plugin을 쓰는 이유

영속 메모리는 보통 세 가지로 실패한다. 사실을 잃어버리거나, 조용히 다시 쓰거나, context를 소리 없이 먹는다. 아래 보장은 각각 그 실패 하나를 막으며, [메모리 lifecycle과 recall](#메모리-lifecycle과-recall)의 규범 계약으로 강제된다.

| 보장 | 실제 의미 |
| --- | --- |
| **데이터베이스 없는 Markdown** | `MEMORY.md` 색인 하나와 주제별 `<slug>.md` 파일. 자기 편집기에서 읽고 grep하고 diff하고 수정할 수 있다. 불투명한 저장 형식이나 벤더 종속이 없다. |
| **임베딩도 벡터 저장소도 없음** | `memory_recall`은 요청 시점에 slug, description, body에 BM25F를 적용해 순위를 낸다. 모델 다운로드, 색인 빌드, API 키, 콜드 스타트가 없다. |
| **결정적 순위** | 같은 코퍼스와 같은 질의는 항상 같은 순서를 만든다. 점수 내림차순, 동점이면 전역이 프로젝트보다 앞, 그다음 slug의 유니코드 코드포인트 순이다. recall은 모델을 호출하지 않고 대화 기록을 읽지 않으며 메모리를 변경하지 않는다. |
| **한국어와 CJK recall이 동작** | 토큰화에 한국어 문자 n-gram이 포함되어, 띄어쓰기 없는 문장도 언어 모델 없이 검색된다. |
| **두 저장소는 절대 섞이지 않음** | 범위를 지정한 작업은 다른 범위로 넘어가지 않고, 범위 교차 검색은 절반만 답하는 대신 전체가 실패한다. 손상된 저장소는 격리되며 정상인 쪽은 계속 쓸 수 있다. |
| **주 session만 쓸 수 있음** | 자식 session과 subagent는 `SESSION_NOT_VERIFIED`를 받는다. subagent가 만든 잡음이 장기 메모리를 오염시키지 못한다. |
| **curation은 증명한 것만 적용** | 자동 적용은 `duplicate-exact` 병합 하나로 제한된다. 파싱된 `type`, `description`, `body`의 동일성을 로컬에서 확인하고, SHA-256 해시로 낡거나 조작된 원본을 차단한다. 유사, 낡음, 대체 같은 의미 판단은 전부 보고 전용이며 사용자 승인을 기다린다. |
| **curation은 되돌릴 수 있고 한계가 있음** | 적용 전에 복구 가능한 원본을 `.trash/<runId>/`에 보관하고, curation은 메모리 파일을 완전 삭제하지 않으며, curator subagent에는 도구가 하나도 없고, 한 session에 도달하는 제안은 최대 세 개다. 일시 중지, 재개, 강제 실행, 상태 확인은 slash command로 한다. |
| **완전 삭제가 없음** | archive와 delete는 출처 메타데이터를 유지한 불변 항목 하나를 옮긴다. restore는 정확한 `(scope, source, entry_id)` 하나만 대상으로 하며 덮어쓰기, 병합, 이름 변경을 하지 않는다. slug가 이미 차 있으면 `ACTIVE_COLLISION`을 반환하고 아무것도 바꾸지 않는다. |
| **추측이 아닌 격리로 얻는 장애 안전성** | 중단된 변경은 커밋된 결과로 멱등하게 수렴하거나, 그 저장소가 `RECOVERY_BLOCKED`로 격리된다. 불완전한 묶음이 독자에게 보이는 일은 없다. |
| **한계가 정해진 context 비용** | 주입 블록, 포인터 줄 수, 범위별 배분은 바이트 예산으로 설정된다. recall은 주제 200개, 주제당 32 KiB, 합계 512 KiB, 응답 25,000바이트에서 상한이 걸리고 본문 없이 메타데이터만 돌려준다. |
| **README가 계약** | RFC 2119 요구사항, 빠짐없는 공개 오류 표, 수용 시나리오가 있다. 관측 가능한 동작을 바꾸는 runtime 변경은 같은 리비전에서 그 절을 함께 바꿔야 한다. |

## 다른 방식과의 비교

| 방식 | 이 plugin이 다른 점 |
| --- | --- |
| `AGENTS.md`, `CLAUDE.md` 같은 정적 지침 파일 | 항상 context에 전부 올라가고 lifecycle과 범위가 없으며 예산 없이 커진다. 여기서는 포인터 색인만 주입되고 본문은 필요할 때 읽는다. |
| 호스팅 메모리 서비스 | API 키와 네트워크 왕복이 필요하고, 사실이 기기 밖으로 나가며, 순위 산정이 불투명하다. 여기서는 전부 로컬에서 돌고 순위 공식이 문서에 적혀 있다. |
| 임베딩 기반 로컬 plugin | 모델을 함께 배포하고 색인을 만들며, 결정적이지 않은 이웃을 돌려주고 CJK 동작을 보장하는 경우가 드물다. BM25F는 즉시 동작하고 재현 가능하며 한국어 n-gram을 토큰화한다. |
| 에이전트가 관리하는 메모리 | 모델이 무엇을 병합하고 버릴지 결정한다. 여기서 모델은 제안만 할 수 있고, 유일한 자동 적용은 로컬에서 증명된 완전 중복이다. |

이 설계의 대가는 그대로 밝힌다. recall은 어휘 기반이므로 질의와 공통 어휘가 없는 메모리는 찾지 못한다. 결정성, 감사 가능성, 추론 비용 0을 얻기 위한 의도된 교환이다.

## 설치

`opencode` CLI와 [Bun](https://bun.sh)이 필요하다. plugin은 OpenCode가 절대 경로로 불러오는 로컬 checkout에서 실행된다. npm에 배포되어 있지 않으므로 아래 네 단계가 설치 전부이며, placeholder를 채우지 않고 순서대로 실행할 수 있다.

**1. clone하고 checkout을 검증한다.**

```sh
git clone https://github.com/devonestar/opencode-durable-memory.git
cd opencode-durable-memory
bun install
bun run typecheck
```

**2. plugin을 등록한다.** `${XDG_CONFIG_HOME:-~/.config}/opencode/opencode.jsonc`의 `plugin` 배열에 `src/index.ts`의 절대 경로를 항목 하나로 추가한다. 넣을 값은 `echo "$(pwd)/src/index.ts"`로 출력한다.

```jsonc
{
  "plugin": ["/absolute/path/to/opencode-durable-memory/src/index.ts"]
}
```

이 문자열 항목 하나로 설치가 끝난다. 저장, recall, lifecycle 도구가 모두 동작하고, `allowProviderEgress`가 기본값 `false`이므로 curation은 동작하지 않는다. 즉 직접 켜기 전까지 메모리 내용이 모델 제공자에게 전달되지 않는다. curation을 켜고 주입 예산을 조정하는 tuple 형식은 [OpenCode 연결](#opencode-연결)에 있다.

**3. agent, command, skill 자산을 연결한다.** 저장소 루트에서 실행하면 경로를 스스로 해석한다.

```sh
REPO="$(pwd)"
CONFIG_ROOT="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"

mkdir -p "$CONFIG_ROOT/agent" "$CONFIG_ROOT/command" "$CONFIG_ROOT/skills/memory-types"
ln -sfn "$REPO/opencode/agent/memory-curator.md" "$CONFIG_ROOT/agent/memory-curator.md"
ln -sfn "$REPO/opencode/command/memory-review.md" "$CONFIG_ROOT/command/memory-review.md"
ln -sfn "$REPO/opencode/command/memory-curation-status.md" "$CONFIG_ROOT/command/memory-curation-status.md"
ln -sfn "$REPO/opencode/command/memory-curation-run.md" "$CONFIG_ROOT/command/memory-curation-run.md"
ln -sfn "$REPO/opencode/command/memory-curation-pause.md" "$CONFIG_ROOT/command/memory-curation-pause.md"
ln -sfn "$REPO/opencode/command/memory-curation-resume.md" "$CONFIG_ROOT/command/memory-curation-resume.md"
ln -sfn "$REPO/opencode/skills/memory-types/SKILL.md" "$CONFIG_ROOT/skills/memory-types/SKILL.md"
```

**4. 재시작하고 확인한다.** OpenCode는 설정, plugin, agent, command, skill을 시작 시점에 불러오므로 종료하고 다시 실행한 뒤 세 가지가 모두 해석되었는지 확인한다.

```sh
opencode debug config
opencode debug skill
```

### 도구

| 도구 | 용도 |
| --- | --- |
| `memory_save(scope, type, slug, description, body)` | 지속되는 학습 하나를 `global` 또는 `project` 저장소에 기록한다. |
| `memory_recall(query, scope, limit)` | 활성 메모리에서 메타데이터만 반환하는 BM25F 검색. |
| `memory_recall_archive(query, scope, limit)` | 한 범위의 보관 항목을 같은 방식으로 검색한다. |
| `memory_archive(scope, slug)` | 활성 주제 하나를 복구 가능한 항목으로 남기고 사용에서 제외한다. |
| `memory_delete(scope, slug)` | 활성 주제 하나를 복구 가능한 항목으로 남기고 사용자 휴지통으로 옮긴다. |
| `memory_restore(scope, source, entry_id)` | 정확히 지정된 항목 하나를 원래 slug로 되돌린다. |
| `memory_curation_status()` | 가려진 curation 상태, 적격성 지표, 보고서 존재 여부. |
| `memory_curation_run(dryRun)` | 임계값과 대기 시간을 우회해 curation을 한 번 강제 실행한다. |
| `memory_curation_control(action)` | 자동 및 수동 curation을 일시 중지하거나 재개한다. |

### 명령

| 명령 | 용도 |
| --- | --- |
| `/memory-review` | subagent로 누적된 메모리를 점검하고 병합, 재작성, 삭제를 제안한다. 검토 전용이며 쓰지 않는다. |
| `/memory-curation-status` | curation 상태, 적격성 지표, 보고서 존재 여부를 보여준다. |
| `/memory-curation-run` | 로컬에서 검증된 안전한 작업만 적용하는 비동기 curation 실행을 강제한다. |
| `/memory-curation-pause` | 자동 및 수동 curation을 일시 중지한다. |
| `/memory-curation-resume` | 자동 및 수동 curation을 재개한다. |

plugin 진입점은 `src/index.ts`다. OpenCode는 내보낸 모든 함수를 plugin으로 호출하므로 기본 plugin 생성 함수만 의도적으로 내보낸다.

## 메모리 데이터와 범위

메모리 데이터는 이 저장소에 보관하지 않는다. runtime은 `XDG_CONFIG_HOME`을 기준으로 OpenCode 설정 루트를 결정하며, 값이 설정되지 않았거나 비어 있으면 `~/.config`를 사용한다. 따라서 아래 경로의 `${XDG_CONFIG_HOME:-~/.config}`는 기본적으로 `~/.config`로 확장된다.

| 범위 | 디스크 경로 | 저장 대상 |
| --- | --- | --- |
| 전역 | `${XDG_CONFIG_HOME:-~/.config}/opencode/memory/` | 개인 수준의 선호, 조직 전반의 시스템, 여러 작업 공간에 적용되는 작업 흐름 |
| 프로젝트 | `${XDG_CONFIG_HOME:-~/.config}/opencode/memory/projects/<namespace>/` | 저장소, 제품 또는 코드베이스에 한정된 사실 |

이 저장소를 관리할 때 실제 `${XDG_CONFIG_HOME:-~/.config}/opencode/memory/` 트리를 이동하거나 Git에 복사하거나 다시 작성해서는 안 된다.

## OpenCode 연결

`${XDG_CONFIG_HOME:-~/.config}/opencode/opencode.jsonc`의 전역 설정은 절대 경로로 이 저장소를 불러온다. 별도의 동작 변경이 목적이 아니라면 plugin 순서와 curation 값을 그대로 유지한다.

```jsonc
[
  "/absolute/path/to/opencode-durable-memory/src/index.ts",
  {
    "curation": {
      "enabled": true,
      "allowProviderEgress": true,
      "model": "openai/gpt-5.6-sol",
      "maxAgeDays": 30,
      "indexRatio": 0.7,
      "changedTopics": 10,
      "cooldownHours": 24,
      "timeoutSeconds": 120,
      "maxTopics": 200,
      "maxTopicBytes": 32768,
      "maxInputBytes": 524288,
      "maxOutputBytes": 131072,
      "notify": true
    }
  }
]
```

튜플에는 시스템 프롬프트 메모리 블록 예산을 조정하는 선택적 `injection` 그룹을 추가할 수 있다. 그룹 전체, 개별 키, 튜플 자체를 생략하면 기존 하드코딩 예산이 그대로 유지되므로 기존 설치에는 영향이 없다.

```jsonc
{
  "injection": {
    "maxBlockBytes": 10000,
    "pointerBudgetBytes": 8000,
    "pointerMaxLines": 80,
    "projectShare": 0.6
  }
}
```

| 키 | 기본값 | 범위 | 의미 |
| --- | --- | --- | --- |
| `maxBlockBytes` | 10000 | 2048~100000 | 주입되는 메모리 블록 전체의 UTF-8 byte 상한. 블록이 이 상한에 맞을 때까지 포인터를 제거한다 |
| `pointerBudgetBytes` | 8000 | 512~100000 | 블록 단위 정리 전에 적용되는 index 포인터 줄의 초기 byte 예산 |
| `pointerMaxLines` | 80 | 1~1000 | 두 scope를 합친 index 포인터 줄 수의 최대값 |
| `projectShare` | 0.6 | 0.05~0.95 | 포인터 예산 중 프로젝트 포인터에 예약되는 비율. 나머지는 전역 몫이며, 남는 용량은 상대 scope로 이월된다 |

`injection` 안의 알 수 없는 키와 `curation`/`injection` 밖의 알 수 없는 최상위 그룹은 조용히 무시되지 않고 plugin 로드 시점에 거부된다.

OpenCode는 시작할 때 설정, plugin, agent, command, skill을 불러온다. 이 저장소나 연결된 설정 자산을 변경한 뒤에는 OpenCode를 종료하고 다시 시작한다.

## 설정 자산

`opencode/` 아래 파일은 메모리 전용 OpenCode 자산의 유일한 ACTIVE 편집본이다.

- `opencode/agent/memory-curator.md`
- `opencode/command/memory-review.md`
- `opencode/command/memory-curation-status.md`
- `opencode/command/memory-curation-run.md`
- `opencode/command/memory-curation-pause.md`
- `opencode/command/memory-curation-resume.md`
- `opencode/skills/memory-types/SKILL.md`

`${XDG_CONFIG_HOME:-~/.config}/opencode/{agent,command,skills}/` 아래의 표준 탐색 경로에는 이 저장소를 가리키는 절대 symlink 7개가 있다. 숨겨진 백업 디렉터리에 과거 스냅샷이 남아 있을 수 있지만, 이 스냅샷은 활성 원본이 아니다. 이를 편집하거나 복사본 트리를 별도로 관리해서는 안 된다.

저장소를 이동한 경우 다음 절차를 따른다.

1. 실제 `opencode.jsonc`에서 메모리 튜플의 첫 번째 요소를 `src/index.ts`의 새 절대 경로로 바꾼다. JSONC는 아래에서 사용하는 셸 변수를 확장하지 않는다.
2. 새 저장소 절대 경로로 symlink 7개를 모두 다시 만든다.

```sh
REPO="/absolute/path/to/opencode-durable-memory"
CONFIG_ROOT="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"

mkdir -p "$CONFIG_ROOT/agent" "$CONFIG_ROOT/command" "$CONFIG_ROOT/skills/memory-types"
ln -sfn "$REPO/opencode/agent/memory-curator.md" "$CONFIG_ROOT/agent/memory-curator.md"
ln -sfn "$REPO/opencode/command/memory-review.md" "$CONFIG_ROOT/command/memory-review.md"
ln -sfn "$REPO/opencode/command/memory-curation-status.md" "$CONFIG_ROOT/command/memory-curation-status.md"
ln -sfn "$REPO/opencode/command/memory-curation-run.md" "$CONFIG_ROOT/command/memory-curation-run.md"
ln -sfn "$REPO/opencode/command/memory-curation-pause.md" "$CONFIG_ROOT/command/memory-curation-pause.md"
ln -sfn "$REPO/opencode/command/memory-curation-resume.md" "$CONFIG_ROOT/command/memory-curation-resume.md"
ln -sfn "$REPO/opencode/skills/memory-types/SKILL.md" "$CONFIG_ROOT/skills/memory-types/SKILL.md"
```

3. 이동한 저장소에서 `bun run check`, `opencode debug config`, `opencode debug skill`을 실행한다.
4. 이동한 plugin과 연결된 자산을 불러오도록 OpenCode를 종료하고 다시 시작한다.

## 개발

저장소의 로컬 의존성을 설치하고 Bun으로 품질 게이트를 실행한다.

```sh
bun install
bun test
bun run typecheck
bun run check
```

`bun run typecheck`와 `bun test test/config.test.ts` 같은 저장소의 개별 로컬 단위 테스트 파일에는 Bun과 설치된 저장소 의존성만 필요하다. 전체 `bun run check`는 운영 스택 스모크 테스트도 실행한다. 따라서 `PATH`에 등록된 `opencode` CLI와 OMO, Claude 인증, 메모리 plugin 튜플, 연결된 agent, command, skill 자산이 정상 작동하는 실제 스택이 필요하다.

## 메모리 lifecycle과 recall

이 절은 lifecycle과 명시적 recall에 관한 규범적 기능 계약이다. 대문자 핵심어 **MUST**, **MUST NOT**, **SHOULD**, **MAY**는 RFC 2119와 RFC 8174에 정의된 의미로만 해석한다. 각각 반드시 해야 한다, 해서는 안 된다, 권고한다, 할 수 있다는 뜻이다. 이 용어는 내부 설계 선호가 아니라 외부에서 관측 가능한 동작을 규정한다.

### 목적과 비목표

Lifecycle 도구를 사용하면 검증된 primary session이 영속 메모리 하나를 활성 메모리에서 제외하면서 정확히 복구 가능한 항목을 보존하고, 나중에 해당 항목을 복원할 수 있다. Recall 도구는 활성 메모리 또는 보관된 메모리를 대상으로 범위가 제한된 메타데이터 전용 어휘 검색을 제공한다.

이 계약은 영구 삭제, 보존 기한 만료, 벡터 또는 의미 기반 검색, 대화 기록 검색, 프롬프트 주입, scope 간 대체 처리, `scope: "all"`의 일부 결과, 자동 lifecycle 결정을 정의하지 않는다. 무기한 보존은 plugin에 제거 작업이나 TTL이 없다는 뜻이다. 수동 파일 시스템 삭제, 저장소 장애, 백업 정책 또는 plugin 외부에서 발생한 손실로부터 데이터를 보호한다는 뜻은 아니다.

### 용어와 저장소 구성

- **저장소**: 하나의 전역 또는 프로젝트 메모리 루트.
- **활성 주제**: 저장소의 `MEMORY.md` index에서 유효한 포인터로 표시된 유효한 `<slug>.md` 주제.
- **Lifecycle 항목**: 변경 불가능한 원본 기록과 주제 payload에 현재 lifecycle 상태를 더한 항목. 하나의 source와 하나의 scope 안에서 `entry_id`로 식별한다.
- **정확한 튜플**: `(scope, source, entry_id)`. 복원 조회는 이 튜플의 어떤 구성 요소도 범위를 넓히지 않는다.
- **검증된 primary session**: 상위 session이 없고 primary로 확인된 session. 하위 session과 상태를 확인할 수 없는 session은 검증되지 않은 것으로 본다.
- **복구 차단 저장소**: lifecycle 상태를 안전하게 조정하거나 교차 검증할 수 없는 저장소.

각 저장소는 다음 영역으로 구성된다.

| 영역 | 내용 | 주입 노출 | 검색 노출 | 보존 기간 |
| --- | --- | --- | --- | --- |
| 저장소 루트 | `MEMORY.md`와 활성 주제 파일 | 활성 index 내용은 일반 메모리 주입 대상이 될 수 있음 | 유효하게 index된 주제는 `memory_recall` 대상이 될 수 있음 | 갱신, 보관 또는 삭제될 때까지 |
| `.archive/index.json` 및 `.archive/entries/<entry_id>/` | 정본 archive index와 보관 항목 | 노출 안 됨 | 현재 보관된 항목만 `memory_recall_archive` 대상이 될 수 있음 | 무기한, 일반적인 파일 시스템 손실 가능 |
| `.user-trash/entries/<entry_id>/` | `memory_delete`로 생성된 항목 | 노출 안 됨 | 노출 안 됨 | 무기한, 일반적인 파일 시스템 손실 가능 |
| `.trash/<runId>/` | 적용된 자동 curation의 변경 전 원본 | 노출 안 됨 | 노출 안 됨 | 무기한, 일반적인 파일 시스템 손실 가능 |
| `.memory-lifecycle/transactions/` | lifecycle 변경의 복구 기록 | 노출 안 됨 | 노출 안 됨 | 내부 복구 상태 |

### 요구사항

- **AUTH-1**: 모든 lifecycle 및 recall 도구는 요청된 corpus를 읽거나 변경하기 전에 하위 session 또는 검증되지 않은 session을 **MUST** `SESSION_NOT_VERIFIED`로 거부한다.
- **AUTH-2**: `memory_archive`, `memory_delete`, `memory_restore`는 명시적인 사용자 요청이 있은 뒤에만 사용하는 도구라고 agent에 **MUST** 설명한다. 이 규칙은 agent의 도구 선택을 통제한다. Plugin은 의도의 출처를 독립적으로 입증하지 않으며, 입증한다고 주장해서는 **MUST NOT** 된다. 검증된 primary session에서 호출되면 두 번째 확인은 필요하지 않다.
- **SCOPE-1**: Lifecycle 작업은 요청된 scope인 `global` 또는 `project` 중 정확히 하나를 **MUST** 사용한다. 다른 scope를 검색하거나, 그 scope에서 복원하거나, 그 scope로 대체 처리해서는 **MUST NOT** 된다.
- **SCOPE-2**: `memory_recall`은 `all`, `global`, `project`를 **MUST** 받으며 기본값은 `all`이다. 선택된 저장소 중 하나라도 사용할 수 없거나 복구 차단 상태이면 `all` 요청 전체가 **MUST** 실패한다. `memory_recall_archive`는 정확히 `global` 또는 `project`를 **MUST** 요구한다.
- **SCOPE-3**: 시작 시 각 scope를 ready, unavailable, recovery-blocked 중 하나로 독립적으로 **MUST** 분류한다. 차단된 scope는 lifecycle 변경과 recall에서 계속 격리해야 하며, 별도로 요청한 독립적인 준비된 scope를 비활성화해서는 **MUST NOT** 된다.
- **STATE-1**: 보관과 삭제는 각각 활성 주제 하나를 새로운 lifecycle 항목 하나로 **MUST** 옮긴다. 보관은 source를 `archive`, state를 `archived`로 설정한다. 삭제는 source를 `trash`, state를 `trashed`로 설정한다.
- **STATE-2**: 복원은 정확한 튜플 하나를 **MUST** 대상으로 한다. 원래 payload를 원래 slug에 복원하고 원본 메타데이터를 보존하며, 현재 state를 `restored`로 **MUST** 설정한다. 다른 항목을 덮어쓰거나 병합하거나 이름을 바꾸거나 대신 사용해서는 **MUST NOT** 된다.
- **STATE-3**: 복원된 보관 항목은 archive recall에서 **MUST** 제외한다. 무결성 검사를 위해 보관 원본과 payload를 **MUST** 보존하며, 현재 `restored` state에서 복원을 반복하면 **MUST** `ALREADY_RESTORED`를 반환한다.
- **VIS-1**: 활성 recall은 선택된 저장소 index가 참조하는 유효한 활성 주제만 **MUST** 고려한다. Archive recall은 요청된 archive index에 있는 유효한 현재 보관 항목만 **MUST** 고려한다. User trash와 curation trash는 검색하거나 주입해서는 **MUST NOT** 된다.
- **VIS-2**: Recall 성공 결과는 메타데이터만 **MUST** 노출한다. 활성 결과에는 `scope`, `slug`, `type`, `description`, `score`가 포함된다. Archive 결과에는 `entry_id`와 `archived_at`도 포함된다. 두 도구 모두 본문, 파일 시스템 경로, 콘텐츠 해시, 트랜잭션 데이터, 복구 산출물을 노출해서는 **MUST NOT** 된다.
- **VIS-3**: 순위 계산은 요청 시점에 `slug`, `description`, `body`를 대상으로 BM25F를 사용해 로컬에서 **MUST** 실행하며, 토큰화는 한국어 문자 n-gram을 포함하고 결정적이어야 한다. Slug 일치는 설명 일치보다 가중치가 높고, 설명 일치는 본문 일치보다 높다. 결과는 점수 내림차순, 동점이면 전역을 프로젝트보다 먼저, 그다음 slug의 Unicode 코드 포인트 순으로 **MUST** 결정적으로 정렬한다. Recall은 모델을 호출하거나 대화 기록을 검사하거나 메모리를 변경하거나 결과를 시스템 프롬프트에 추가해서는 **MUST NOT** 된다.
- **IO-1**: Recall query는 앞뒤 공백을 제거한 뒤 비어 있지 않고 올바른 형식의 Unicode이며 최대 500 UTF-8 byte여야 한다(**MUST**). `limit`은 1부터 10까지의 정수여야 하며(**MUST**), 기본값은 5다. 직렬화된 recall 응답은 최대 25,000 UTF-8 byte여야 한다(**MUST**). 응답이 이 제한에 맞을 때까지 일치 결과를 끝에서부터 **MUST** 제거하고 잘림 여부를 보고한다.
- **IO-2**: 한 요청이 선택한 활성 corpus 전체 또는 한 요청이 선택한 단일 scope의 archive corpus는 주제 200개, 주제당 32 KiB, 전체 입력 512 KiB로 **MUST** 제한한다. Lifecycle JSON 파일은 64 KiB, lifecycle 디렉터리 목록은 항목 1,000개로 **MUST** 제한한다. 제한 안에서 완전히 읽을 수 없는 corpus는 일부 검색 결과를 반환하지 말고 **MUST** 실패한다.
- **IO-3**: Lifecycle 및 archive 읽기는 형식이 잘못됐거나, 일관되지 않거나, symlink이거나, 일반 파일이 아니거나, 저장소 외부에 있는 산출물을 **MUST** 거부한다. 기록, index, 현재 state, 원본, 주제 메타데이터, byte 길이, 콘텐츠 다이제스트를 **MUST** 교차 검증한다. 무결성이 불확실하면 **MUST** 실패로 닫는다.
- **REC-1**: Lifecycle 변경은 저장소별로 **MUST** 직렬화한다. 서로 다른 저장소의 동시 작업은 독립적으로 진행할 수 있다(**MAY**). 활성 slug가 이미 사용 중임을 발견한 복원은 **MUST** `ACTIVE_COLLISION`을 반환하며, 어느 쪽도 변경해서는 **MUST NOT** 된다.
- **REC-2**: Lifecycle 항목 또는 트랜잭션 묶음의 공개는 묶음 가시성 수준에서 **MUST** 원자적이어야 한다. 읽는 쪽은 완전한 묶음을 보거나 아무것도 보지 않아야 한다. Index와 state 교체는 일반적인 로컬 파일 시스템 의미론 안에서 **MUST** 원자적이어야 한다. 이 계약은 해당 의미론을 넘어서는 분산 잠금이나 내구성을 보장하지 않는다.
- **REC-3**: 새 lifecycle 변경 전에 시작 시점과 요청 시점의 복구는 무결성을 입증할 수 있을 때 미완료 작업을 커밋된 결과로 **MUST** 멱등하게 수렴시킨다. 복구를 반복해도 다른 항목을 생성하거나 선택된 payload를 변경해서는 **MUST NOT** 된다. 수렴이나 교차 검증을 입증할 수 없다면 해당 저장소만 복구 차단 상태가 된다.

### 도구 계약

도구 인자 스키마는 실행 전에 검증한다. 안전하지 않은 slug, 유효하지 않은 enum, 형식이 잘못된 UUID, 비어 있거나 지나치게 큰 query, 범위를 벗어난 limit 같은 스키마 거부는 OpenCode 도구 프레임워크가 보고하며, 아래 실행 오류 JSON 객체에 속하지 않는다.

모든 실행 성공과 실패는 도구 출력에 JSON으로 표시한다. Lifecycle 도구는 호출 한 번에 항목 하나를 처리한다.

#### `memory_archive(scope, slug)`

지정한 활성 주제를 정확한 scope의 archive로 옮긴다. 성공 결과는 다음과 같다.

```json
{"ok":true,"code":"ARCHIVED","entry_id":"<uuid>","slug":"<slug>","scope":"global|project","source":"archive"}
```

#### `memory_delete(scope, slug)`

지정한 활성 주제를 정확한 scope의 user trash로 옮긴다. 성공 결과는 다음과 같다.

```json
{"ok":true,"code":"TRASHED","entry_id":"<uuid>","slug":"<slug>","scope":"global|project","source":"trash"}
```

#### `memory_restore(scope, source, entry_id)`

정확한 튜플을 복원하며 `source`는 `archive` 또는 `trash`다. 호출자는 보관 또는 삭제가 반환한 `entry_id`를 사용한다. 성공 결과는 다음과 같다.

```json
{"ok":true,"code":"RESTORED","entry_id":"<uuid>","slug":"<original-slug>","scope":"global|project","source":"archive|trash"}
```

#### `memory_recall(query, scope = "all", limit = 5)`

선택한 활성 corpus를 검색한다. 성공 결과는 다음과 같다.

```json
{"ok":true,"query":"<trimmed-query>","scope":"all|global|project","matched_count":0,"result_count":0,"results_truncated":false,"results":[{"scope":"global|project","slug":"<slug>","type":"user|feedback|project|reference","description":"<description>","score":0.0}]}
```

`matched_count`는 `limit`과 출력 크기 제한에 따른 잘림을 적용하기 전 양수 점수 일치 항목 수다. `result_count`는 반환된 배열 길이다. 반환된 결과가 일치 항목보다 적으면 `results_truncated`는 true다.

#### `memory_recall_archive(query, scope, limit = 5)`

필수로 지정한 하나의 scope에서 현재 정본 보관 항목을 검색한다. `archived_at`은 항목 생성 타임스탬프다. 성공 결과는 다음과 같다.

```json
{"ok":true,"query":"<trimmed-query>","scope":"global|project","matched_count":0,"result_count":0,"results_truncated":false,"results":[{"scope":"global|project","slug":"<slug>","type":"user|feedback|project|reference","description":"<description>","score":0.0,"entry_id":"<uuid>","archived_at":"<timestamp>"}]}
```

### 공개 실행 오류

모든 실행 실패는 `{"ok":false,"error":"<CODE>"}` 형식이다. 다음 표는 공개 lifecycle 및 recall 실행 오류 전체를 빠짐없이 나타낸다.

| 코드 | 도구 | 의미 |
| --- | --- | --- |
| `SESSION_NOT_VERIFIED` | 5개 모두 | Session이 하위 session이거나 primary로 검증할 수 없다. |
| `PROJECT_UNAVAILABLE` | project를 선택한 경우 5개 모두, `all`을 사용한 활성 recall | 프로젝트 저장소를 사용할 수 없다. 전역 대체 처리나 일부 `all` 결과는 반환하지 않는다. |
| `STORE_UNAVAILABLE` | global을 선택한 경우 5개 모두, `all`을 사용한 활성 recall, 읽을 수 없는 recall corpus | 필요한 전역 저장소 또는 선택한 corpus를 안전하게 읽을 수 없다. |
| `RECOVERY_BLOCKED` | 5개 모두 | 선택한 저장소에 해결되지 않은 lifecycle 또는 무결성 상태가 있다. |
| `CORPUS_LIMIT_EXCEEDED` | recall 도구 2개 | 선택한 corpus가 주제, byte, index 또는 제한 읽기 한도를 초과해 전체 순위 계산이 불가능하다. |
| `ACTIVE_NOT_FOUND` | `memory_archive`, `memory_delete` | 정확한 활성 slug가 없거나 제거할 수 있는 유효한 활성 주제가 아니다. |
| `NOT_FOUND` | `memory_restore` | 정확한 `(scope, source, entry_id)`가 복원 가능한 항목을 식별하지 않는다. |
| `ACTIVE_COLLISION` | `memory_restore` | 원래 slug가 활성 메모리에 이미 있다. 어떤 항목도 덮어쓰거나 병합하거나 이름을 바꾸지 않는다. |
| `ALREADY_RESTORED` | `memory_restore` | 정확한 항목의 현재 state가 이미 restored다. |

### 수용 시나리오

| 시나리오 | 예상 관측 결과 | 요구사항 |
| --- | --- | --- |
| 보관, 검색, 복원 | 보관은 `ARCHIVED`를 반환한다. 활성 recall에서는 더 이상 해당 주제를 찾을 수 없다. Archive recall은 메타데이터만 반환한다. 정확한 복원은 `RESTORED`를 반환한다. 이후 archive recall에서는 해당 항목이 제외된다. | AUTH-1, STATE-1..3, VIS-1..2 |
| 삭제와 복원 | 삭제는 `TRASHED`를 반환한다. 두 recall 도구 모두 해당 항목을 찾지 못한다. Trash 튜플을 복원하면 원본을 바꾸지 않고 원래 slug와 payload를 재현한다. | SCOPE-1, STATE-1..2, VIS-1 |
| Scope 격리 | 프로젝트 작업은 전역 데이터를 읽지 않는다. 프로젝트가 없으면 `PROJECT_UNAVAILABLE`을 반환한다. 차단된 프로젝트는 명시적인 준비된 전역 요청을 막지 않는다. 활성 `all`은 전역 결과만 반환하지 않고 실패한다. | SCOPE-1..3 |
| 권한과 검증 | 하위 session 또는 상태를 알 수 없는 session은 `SESSION_NOT_VERIFIED`를 받는다. 형식이 잘못된 인자는 실행 오류 JSON으로 반환되지 않고 스키마에서 거부된다. 명시적 요청 문구는 출처 탐지가 아니라 agent 계약으로 강제한다. | AUTH-1..2, IO-1 |
| 충돌과 반복 복원 | 이미 사용 중인 slug로 복원하면 변경 없이 `ACTIVE_COLLISION`을 반환한다. 이미 복원된 튜플을 복원하면 `ALREADY_RESTORED`를 반환한다. 잘못된 튜플은 `NOT_FOUND`를 반환한다. | STATE-2, REC-1 |
| 제한적이고 결정적인 recall | 같은 corpus와 query는 같은 순위와 메타데이터 필드를 만든다. 지나치게 크거나 불완전한 corpus는 실패한다. 출력은 25,000 UTF-8 byte 이내이며 잘림 여부를 보고한다. | VIS-2..3, IO-1..3 |
| 중단된 변경 | 중단 후 복구는 완전한 커밋 상태로 한 번 수렴하거나 해당 저장소를 `RECOVERY_BLOCKED`로 격리한다. 일부 묶음은 공개되지 않으며 다른 정상 scope는 계속 사용할 수 있다. | SCOPE-3, REC-2..3 |

### 변경 규칙

도구 인자, 성공 필드, 공개 오류, 가시성, 순위, 제한, scope 동작, lifecycle 전이, 복구 결과를 바꾸는 runtime 변경은 같은 변경 단위에서 이 절도 변경해야 한다. 새 공개 실행 오류에는 표의 행과 수용 시나리오 연결이 필요하다. 위의 모든 요구사항과 관측 가능한 형식이 그대로 유지되는 경우에만 README를 갱신하지 않고 구현 세부사항을 바꿀 수 있다. 새 버전을 불러오도록 도구 등록이나 plugin 코드를 변경한 뒤에는 OpenCode를 종료하고 다시 시작한다.

## 자동 curation 정책

자동 적용은 로컬에서 입증된 `duplicate-exact` `MERGE`로 제한한다. 의미적 유사성, 오래된 콘텐츠에 대한 판단, 그 밖의 모든 비정확 일치 제안은 보고만 한다. Curation은 메모리 파일을 영구 삭제하지 않는다. 변경을 적용하기 전에 복구 가능한 원본을 해당 메모리 저장소의 `.trash/<runId>/` 아래에 보관한다.
`duplicate-exact`에서 exact는 byte 단위 동일성이 아니라 파서가 정의한 앞뒤 공백 정규화를 거친 뒤 파싱한 `type`, `description`, `body`가 같다는 뜻이다. 내부 콘텐츠 차이는 여전히 안전하지 않은 것으로 본다. 원시 SHA-256 해시는 오래됐거나 변조된 원본을 계속 격리한다.
큐레이터는 변경 제안이 없는 토픽에 `KEEP` operation을 만들지 않는다. 유효한 비정확 일치 operation은 본문을 제외한 namespace별 제안으로 저장하고, operation 내용과 source hash를 기준으로 중복을 제거한다. 다음 verified primary session에는 최대 3건을 전달한다. 이 전달은 best-effort이며 의미적 변경을 자동 적용할 권한을 추가하지 않는다.

## 아키텍처와 의존성 고정

시스템 아키텍처와 curation lifecycle은 [`docs/architecture.html`](docs/architecture.html)을 참고한다.

검증된 동작 기준선을 유지하기 위해 `@opencode-ai/plugin`과 직접 가져오는 `@opencode-ai/sdk`는 의도적으로 `1.18.3`에 고정한다. 설치된 OpenCode runtime은 더 최신일 수 있다. `opencode --version`을 실행해 확인한다. 의존성과 runtime을 함께 정렬하는 작업은 별도의 향후 과제이며, 전체 테스트 모음과 실제 설정 검사를 다시 실행해야 한다.
