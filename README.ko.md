# sqlite-graph-mcp

**English documentation: [README.md](README.md)** · 한국어 문서

[![CI](https://github.com/developjik/sqlite-graph-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/developjik/sqlite-graph-mcp/actions/workflows/ci.yml)

**AI 에이전트가 진짜로 인용할 수 있는 코드·스펙 그래프** — 임베딩 없음, Docker 없음, Neo4j 없음, API 키 없음.
SQLite 파일 하나, 다섯 개 연산자, 모든 답에는 `file:line` 근거가 붙습니다.

```
npx -y @developjik/sqlite-graph-mcp index
npx -y @developjik/sqlite-graph-mcp plan 'find "walker" kind=symbol | walk type=defines dir=in depth=1 | filter kind=file'
# → src/graph/walker.ts:1
```

대부분의 "코드 그래프" 도구는 임베딩 파이프라인을 돌리고, 소스를 벡터 데이터베이스에 밀어 넣은 뒤,
결국 직접 검증해야 하는 의미상 유사한 청크를 돌려줍니다. 이 도구는 `index` 한 번으로 작고 결정적인
그래프를 로컬 SQLite 파일에 만들고, 재귀 CTE로 구조적 질문에 답합니다. 에이전트가 "이 파일이
`walkGraph`를 정의하고, `index.ts`가 이를 import한다"고 말할 때, 그 주장에는 경로와 줄 번호가
붙어 있습니다.

---

## 왜 SQLite에 그래프를 두는가

- **결정적.** 같은 워크스페이스는 항상 같은 그래프를 만듭니다. 모델, 청킹 전략, 유사도 임계값에
  의존하는 것이 없습니다.
- **인프라 제로.** `better-sqlite3` 기반 저장소, `.sqlite-graph/index.db` 파일 하나,
  `.gitignore` 친화적. 데몬·컨테이너·계정이 필요 없습니다.
- **커밋마다 재색인할 만큼 빠름.** 수천 파일 수준이면 1초 안에 색인됩니다.
- **감사 가능.** 노드 하나가 행 하나, 엣지 하나가 행 하나. `sqlite3`로 데이터베이스를 열어
  에이전트의 추론을 직접 확인할 수 있습니다.
- **구조적으로 보장되는 인용.** 노드는 `path`와 `line`을 가지고, 엣지는 그 엣지를 만든
  import/정의/링크의 줄 번호를 가집니다.

## 무엇을 색인하나

| 노드 종류 | 출처 | 키 예시 |
| --- | --- | --- |
| `file` | `.ts .tsx .js .jsx .mts .cts .mjs .cjs .md .mdx .markdown package.json` | `file:src/index.ts` |
| `symbol` | 최상위 `function` / `class` / `const|let|var` / `interface` / `type` / `enum` | `symbol:src/graph/walker.ts#walkGraph` |
| `heading` | 마크다운 `#` 제목, GitHub 스타일 슬러그 | `heading:docs/spec.md#usage` |
| `package` | `package.json` 이름 + 의존성, bare import 포함 | `package:left-pad` |

| 엣지 종류 | 의미 |
| --- | --- |
| `imports` | file → file (정적 `import`, `export … from`, `require`, 동적 `import()`), tsconfig `paths` 별칭과 워크스페이스 로컬 패키지 엔트리 포함 |
| `exports` | file → symbol (선언이 export됨) |
| `defines` | file → symbol, file → heading, `package.json` → 그 패키지 |
| `links_to` | 마크다운 링크/참조 → file 또는 heading, `#앵커` 포함 |
| `depends_on` | file → package, 매니페스트의 package → 의존성 |
| `references` | file → symbol: 그 파일이 이 심볼을 **실제로 사용** (네임드/디폴트/네임스페이스/`require` 바인딩 기준, 미사용 import도 import 라인에 엣지 인용) |

파일에는 태그가 붙고(`code`, `ts`, `doc`, `test`, `entry`, `manifest`, `exported`, …) 태그로
필터할 수 있습니다 — `graph_orphans`가 별도 인자 없이 테스트·엔트리 파일을 건너뛰는 것도
이 태그 덕분입니다.

### 추출 엔진

기본 **`ast` 엔진**은 tree-sitter WASM 문법(패키지에 동봉)으로 TypeScript/TSX(및 일반
JS)를 실제 파싱합니다 — 네이티브 빌드도, 네트워크도 필요 없습니다. Import·심볼·export는
파스 트리에서 나오고, `references` 엣지는 import한 바인딩을 **처음 실제 사용한 줄**에
인용합니다 — import만 하고 사용하지 않는 바인딩은 import 라인에 인용합니다(절 자체가
리네임에 깨지는 텍스트 위치이므로). WASM 로드에 실패하면 색인은 **`heuristic` 엔진**(주석 마스킹 정규식,
import 절 기반 references)으로 자동 폴백됩니다. 명시적으로 지정하려면
`graph_index { engine: "heuristic" }` 또는 `--engine heuristic`; 색인 결과의
`engine` 필드가 실제로 어떤 엔진이 돌았는지 알려줍니다.

## 설치

패키지는 **`@developjik/sqlite-graph-mcp`** 로 배포됩니다 (npm의 비스코프 이름은 다른
프로젝트이므로 항상 스코프를 붙이세요). Node.js **20+** 필요 (20과 22에서 테스트).
`better-sqlite3`은 프리빌트 바이너리를 제공합니다. 설치 후 바이너리 이름은
`sqlite-graph-mcp` (별칭 `sqlite-graph`)입니다.

```bash
# 설치 없이 실행
npx -y @developjik/sqlite-graph-mcp --help

# 또는 전역 설치
npm install -g @developjik/sqlite-graph-mcp

# 또는 의존성으로 설치
npm install @developjik/sqlite-graph-mcp
```

## MCP 설정

서버는 stdio로 MCP를 말합니다. `--root`는 색인할 워크스페이스이며, 기본값은 프로세스의
현재 디렉터리 — 보통 MCP 클라이언트가 넘겨주는 값입니다.

### Claude Code
```bash
claude mcp add sqlite-graph -- npx -y @developjik/sqlite-graph-mcp serve --root /absolute/path/to/repo
```

### Cursor (`~/.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "sqlite-graph": {
      "command": "npx",
      "args": ["-y", "@developjik/sqlite-graph-mcp", "serve", "--root", "/absolute/path/to/repo"]
    }
  }
}
```

### Codex (`~/.codex/config.toml`)

```toml
[mcp_servers.sqlite-graph]
command = "npx"
args = ["-y", "@developjik/sqlite-graph-mcp", "serve", "--root", "/absolute/path/to/repo"]
```

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "sqlite-graph": {
      "command": "npx",
      "args": ["-y", "@developjik/sqlite-graph-mcp", "serve", "--root", "/absolute/path/to/repo"]
    }
  }
}
```

로컬 클론에서 (레지스트리 없이):

```json
{
  "mcpServers": {
    "sqlite-graph": {
      "command": "node",
      "args": ["/absolute/path/to/sqlite-graph-mcp/dist/bin/cli.js", "serve", "--root", "/absolute/path/to/repo"]
    }
  }
}
```

`.sqlite-graph/index.db`가 없으면 첫 도구 호출에서 자동으로 색인합니다.
대규모 리팩터링 뒤에는 `graph_index`를 다시 실행하세요. 한 트랜잭션으로 그래프를
재구축합니다.

## 다섯 개 연산자

| 연산자 | 도구 | 답하는 질문 |
| --- | --- | --- |
| `find` | `graph_find` | "`walkGraph`가 어디에 정의돼 있지?" |
| `walk` | `graph_walk` | "이 파일이 (전이적으로) 뭘 import하지?" |
| `filter` | `graph_filter` | "이 노드 중 `docs/` 아래 문서는 어떤 것들?" |
| `minus` | `graph_orphans` (차집합) | "어떤 파일이 한 번도 import·링크되지 않았지?" |
| `answer` | `graph_plan` | "위 연산들을 체인으로 잇고 인용을 달아줘." |

### `graph_find`

FTS5 접두사 랭킹 + 서브스트링/글롭 폴백. `index`로 검색해도 `GraphIndexer`가 잡히고,
`*.test.ts`는 글롭으로 동작합니다.

```jsonc
// graph_find { "query": "emoji", "kind": "symbol" }
{
  "count": 1,
  "nodes": [
    {
      "id": 12,
      "key": "symbol:src/greet.ts#greetEmoji",
      "kind": "symbol",
      "name": "greetEmoji",
      "citation": "src/greet.ts:5",
      "snippet": "export const greetEmoji = '👋';",
      "tags": ["symbol", "exported", "variable"]
    }
  ]
}
```

### `graph_walk`

순회는 `edges` 위의 재귀 CTE입니다. 사이클 보호는 경로 기반: 다음 id가 이미 지나온 경로에
있으면 그 가지는 멈춥니다. 그래서 `a → b → a`는 `maxDepth=20`이어도 깊이 1에서
종료됩니다.

```sql
WITH RECURSIVE walk(id, depth, path) AS (
  SELECT id, 0, ',' || id || ',' FROM nodes WHERE id IN (?, ?)
  UNION ALL
  SELECT e.dst, w.depth + 1, w.path || e.dst || ','
  FROM walk w
  JOIN edges e ON e.src = w.id
  WHERE w.depth < :maxDepth
    AND instr(w.path, ',' || e.dst || ',') = 0
    AND e.type IN ('imports', 'links_to')
)
SELECT id, MIN(depth) AS depth FROM walk GROUP BY id ORDER BY depth, id;
```

```jsonc
// graph_walk { "start": ["file:src/index.ts"], "edgeType": "imports", "direction": "out" }
{
  "count": 5,
  "nodes": [
    { "key": "file:src/index.ts",              "depth": 0, "citation": "src/index.ts:1" },
    { "key": "file:src/greet.ts",              "depth": 1, "citation": "src/greet.ts:1" },
    { "key": "file:src/graph/walker.ts",       "depth": 1, "citation": "src/graph/walker.ts:1" },
    { "key": "file:src/graph/cycle-a.ts",      "depth": 2, "citation": "src/graph/cycle-a.ts:1" },
    { "key": "file:src/graph/cycle-b.ts",      "depth": 3, "citation": "src/graph/cycle-b.ts:1" }
  ]
}
```

방향 `in`은 의존하는 쪽을 찾습니다 ("이 이름을 바꾸면 누가 깨질까?"), `both`는 이웃 전체.
`references` 엣지는 이 질문을 구체적으로 만듭니다 — 심볼에서 inbound로 걸으면 그 심볼을
import한 파일 전부가 나옵니다:

```jsonc
// graph_walk { "start": ["symbol:src/graph/walker.ts#walkGraph"], "edgeType": "references", "direction": "in" }
{
  "count": 3,
  "nodes": [
    { "key": "symbol:src/graph/walker.ts#walkGraph", "depth": 0, "citation": "src/graph/walker.ts:7" },
    { "key": "file:src/index.ts",                    "depth": 1, "citation": "src/index.ts:9" },
    { "key": "file:src/graph/walker.test.ts",        "depth": 1, "citation": "src/graph/walker.test.ts:6" }
  ]
}
```

### `graph_filter`

```jsonc
// graph_filter { "ids": [12, 20, 21], "kind": "symbol", "prefix": "src/graph/", "tag": "exported" }
{ "count": 2, "nodes": [ /* WalkOptions, walkGraph */ ] }
```

조건자: `kind`, `notKind`, `path` (글롭), `prefix`, `suffix`, `name`, `regex`, `tag`, `limit`.

### `graph_orphans`

한 쿼리로 차집합: inbound `imports`/`links_to` 엣지가 없는 파일, export된 적 없는 심볼.
테스트·엔트리 파일은 요청하지 않는 한 제외됩니다.

```jsonc
{
  "files":   [{ "path": "src/legacy.ts", "citation": "src/legacy.ts:1" }],
  "symbols": [{ "name": "unusedHelper", "citation": "src/index.ts:13" }],
  "counts":  { "files": 1, "symbols": 2 }
}
```

### `graph_diff` — 이 변경을 배포하면 무엇이 깨질까?

두 워크스페이스 상태를 각각 색인해 그래프를 비교합니다. 각 쪽은 git 리비전(브랜치·태그·SHA
— `git rev-parse`로 검증, 셸 없음) 또는 그냥 디렉터리입니다:

```jsonc
// graph_diff { "base": "main", "head": "HEAD" }
{
  "counts": { "addedNodes": 14, "removedNodes": 3, "addedEdges": 41, "removedEdges": 9,
              "breaking": 1, "newOrphans": 1 },
  "breaking": [
    {
      "symbol": { "key": "symbol:src/graph/walker.ts#walkGraph", "citation": "src/graph/walker.ts:7" },
      "unexportedOnly": true,
      "importers": [
        { "key": "file:src/index.ts", "citation": "src/index.ts:9" },
        { "key": "file:src/graph/walker.test.ts", "citation": "src/graph/walker.test.ts:6" }
      ]
    }
  ],
  "newOrphans": [{ "key": "file:src/legacy.ts", "citation": "src/legacy.ts:1" }],
  "truncated": false
}
```

**breaking**은 head에서 더 이상 export되지 않는(삭제되었거나 export가 제거된) 심볼 중
base 쪽 파일들이 여전히 쓰고 있던 것을 import 인용과 함께 나열합니다 — "이 PR, 머지해도
안전한가?"에 대한 기계 판정입니다. **newOrphans**는 살아있는데 마지막 inbound
`imports`/`links_to` 엣지를 잃은 파일들입니다. CLI 형태는 리뷰 게이트로도 씁니다:

```bash
sqlite-graph-mcp diff main HEAD --check   # breaking이 있으면 exit 3
```


### `graph_plan` — 체인으로 잇기

플랜은 파이프라인입니다. 각 단계는 이전 단계의 노드 집합을 소비하고, `find`는 새 집합을
시작합니다.

```
find "walker" kind=symbol | walk type=defines dir=in depth=1 | filter kind=file
```

같은 플랜을 JSON으로 (LLM이나 스크립트가 보내는 형태):

```json
{
  "steps": [
    { "op": "find", "query": "walker", "kind": "symbol" },
    { "op": "walk", "edgeType": "defines", "direction": "in", "maxDepth": 1 },
    { "op": "filter", "predicate": { "kind": "file" } }
  ],
  "limit": 50
}
```

응답 (요약):

```jsonc
{
  "count": 1,
  "nodes": [{ "key": "file:src/graph/walker.ts", "citation": "src/graph/walker.ts:1", "depth": 1 }],
  "edges": [{ "src": 20, "dst": 22, "type": "defines", "citation": "src/graph/walker.ts:7" }],
  "citations": ["src/graph/walker.ts:1"],
  "steps": [
    { "index": 0, "op": "find",   "inputCount": 0, "outputCount": 1 },
    { "index": 1, "op": "walk",   "inputCount": 1, "outputCount": 2 },
    { "index": 2, "op": "filter", "inputCount": 2, "outputCount": 1 }
  ],
  "explain": [
    "find(\"walker\", kind=symbol) → 1 nodes",
    "walk(from 1, in, defines, depth=1) → 2 nodes",
    "filter({\"kind\":\"file\"}) 2 → 1 nodes"
  ],
  "truncated": false
}
```

파이프라인 문법:

| 단계 | 옵션 |
| --- | --- |
| `find <query>` | `kind=file,symbol`, `limit=20`; `*` 는 전체 나열, `*.ts` 는 글롭 |
| `walk` | `type=imports,links_to,references`, `dir=out|in|both`, `depth=6`, `start=<id>,<key>`, `limit=` |
| `filter` | `kind=`, `notKind=`, `path=src/**`, `prefix=`, `suffix=`, `name=`, `regex=`, `tag=`, `limit=` |
| `minus find <query>` | 현재 집합에서 다른 find 결과를 뺌 |

## CLI

같은 엔진을 MCP 클라이언트 없이도 쓸 수 있습니다:

```bash
sqlite-graph-mcp index [dir]                 # 그래프 생성/재구축
sqlite-graph-mcp find "walkGraph" --kind symbol
sqlite-graph-mcp walk <id|key> --type imports --dir out --depth 3
sqlite-graph-mcp plan 'find "graph" | walk type=imports depth=2'
sqlite-graph-mcp orphans --include-tests
sqlite-graph-mcp serve --root . --db .sqlite-graph/index.db
```

모든 명령은 `--json`을 받고, `find`는 매칭이 없으면 exit `1`을 반환해 셸 조건문에
쓸 수 있습니다.

## 아직 하지 않는 것

한계에 대한 정직함이 긴 기능 목록보다 중요합니다:

- **스코프 완전 분석은 아님.** 기본 tree-sitter 엔진은 import한 바인딩과 그 식별자
  사용을 추적하지만 스코프를 모델링하진 않습니다 — import한 이름을 가리는 지역
  변수가 사용으로 세질 수 있고, JSX 식별자는 매칭하지 않습니다. 휴리스틱 폴백
  엔진은 import 절만 봅니다 ("누가 import하지?"는 답해도 "누가 호출하지?"는 못 함).
- **타입 해석은 부분적.** tsconfig/jsconfig `paths` + `baseUrl` (로컬 `extends` 체인)과
  워크스페이스 로컬 패키지(`main`/`module`/`index`)는 실제 파일로 해석합니다.
  package.json `exports` 필드, 번들러 설정 별칭(vite/webpack), `#` 접두사 패키지 내부
  import, 중첩 워크스페이스의 tsconfig는 해석하지 않습니다.
- **변경되지 않은 파일도 다시 파싱.** 재색인은 항상 원자적 전체 재구축입니다 (빠르지만
  증분은 아님).
- **로컬 범위만.** `node_modules`, `dist`, `build`, `.git` 등은 건너뛰며, 512 KiB 초과
  파일과 5,000 파일 초과 워크스페이스도 그렇습니다 (둘 다 `graph_index`에서 설정 가능).

## 개발

```bash
npm install
npm run typecheck   # tsc --noEmit, 테스트 포함
npm test            # 빌드 후 단위 + stdio MCP 통합 테스트 실행
npm run build       # tsc → dist/
```

구조:

```
bin/cli.ts        CLI 진입점 (shebang, 서브커맨드, JSON 출력)
src/ast.ts        tree-sitter(WASM) 엔진: 파스 트리 기반 import/심볼, 바인딩 사용 추적
src/db.ts         스키마, FTS5 인덱스, GraphStore (prepared statements)
src/indexer.ts    워크스페이스 스캔, 주석 마스킹, 심볼/import/제목 추출, tsconfig paths, 워크스페이스 패키지
src/query.ts      SQLite 위의 find / walk / filter / minus / orphans
src/plan.ts       파이프라인 DSL 파서 + 인용 포함 answer 실행기
src/mcp.ts        MCP 서버와 여섯 개 도구
test/             fixtures, 단위 테스트, stdio MCP 프로토콜 테스트
```

테스트 스위트는 인덱서 개수와 멱등성, 확장자 리매핑 (`.js` import → `.ts` 소스),
사용 기반 `references` (별칭/디폴트/네임스페이스 바인딩, 미사용 import의 import 라인
인용, 합성 디폴트 export), 두 엔진 전부, tsconfig `paths` 별칭과 워크스페이스 로컬 패키지
(`test/fixtures/mono` 참고), 스키마 버전 마이그레이션, 사이클 안전 순회, 모든 연산자,
플랜 DSL, 고아 검출, CLI, 그리고 공식 SDK 클라이언트와 줄바꿈 구분 JSON-RPC 양쪽으로의
MCP 핸드셰이크를 다룹니다. `tree-sitter-wasms`를 올린 뒤에는 `npm run vendor:wasm`으로
동봉 문법을 갱신하세요.

## 라이선스

MIT © 2026 Inkwon Jung ([@developjik](https://github.com/developjik))

## 개발 기준선 (DEV-128)

개발과 CI는 Node.js 22.12.0(`.nvmrc`) 이상을 사용합니다. Vitest 5.1.1의 공식 지원 범위에는 Node 20.19가 없습니다. 실행이 된다는 이유로 공식 지원이라고 부르지 않습니다. 패키지 사용자의 기존 engines는 유지합니다. Node 20 지원 패키지는 테스트 러너 없이 빌드한 tarball의 운영 의존성만 설치하고 CLI/import를 별도로 검사합니다. 개발 TypeScript 기준은 7.0.2입니다.
