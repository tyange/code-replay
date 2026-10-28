# code-replay

가이드의 **단계별 완성 코드**를 브라우저에서 타이핑 애니메이션으로 재생하고, 옆의 에디터에서 따라 치는 학습 도구입니다. 터미널에서 `code-replay` 를 실행하면 로컬 서버가 뜨고, 안내된 주소로 들어가 쓰면 됩니다. 가이드 하나는 **세션 파일 하나**(YAML · JSON · TOML)이고, 세션 폴더에 파일을 넣고 빼는 것으로 학습 세션을 추가하고 제거합니다.

## 설치

```bash
git clone git@github-personal:tyange/code-replay.git
cd code-replay
pnpm install
pnpm build
ln -s "$PWD/bin/code-replay.mjs" ~/bin/code-replay   # ~/bin 이 PATH 에 있어야 합니다
```

## 실행

```bash
code-replay            # 또는 code-replay serve --open
```

```
  code-replay v0.1.0  ready in 322 ms

  ➜  Local:    http://localhost:5170/
  ➜  Sessions: 4개 (~/.code-replay/sessions)
```

주소로 들어가 가이드를 고르면, 오른쪽에서 코드가 한 글자씩 쳐지고 왼쪽 **내 코드** 에디터(Monaco)에 따라 칩니다. 가이드 설명은 재생 중에 말풍선으로 나옵니다.

## 세션 관리

| 명령 | 하는 일 |
| --- | --- |
| `code-replay list` | 세션 목록 |
| `code-replay add <파일...>` | 세션 파일을 세션 폴더에 복사 (`--force` 로 같은 slug 덮어쓰기) |
| `code-replay remove <slug>` | 세션 삭제 (`-y` 로 확인 생략) |
| `code-replay import <폴더>` | `guide.json` + git 저장소 형식 가이드를 세션 파일로 변환 (`--format yaml\|json\|toml`) |
| `code-replay new <slug>` | 빈 세션 파일 틀 만들기 |
| `code-replay path` | 세션 폴더 경로 |

- 세션 폴더: `~/.code-replay/sessions` (`--dir` 또는 환경변수 `CODE_REPLAY_HOME` 으로 변경)
- 서버가 켜진 동안 파일을 넣거나 지우면 터미널에 바뀐 목록이 뜨고, 브라우저를 새로고침하면 반영됩니다.
- 이름이 `_` 로 시작하는 파일은 무시합니다(작성 중인 초안용).

## 세션 파일 형식

```yaml
slug: my-guide
title: 내 가이드
summary: 무엇을 만들고 무엇을 배우는지
lang: rust
intro: |                 # 가이드 소개 (Markdown)
  ...
stages:
  - id: "1"
    title: 첫 단계
    doc: |               # 단계 설명 (Markdown)
      이 단계에서 할 일 …
      ▶ `src/main.rs` — 재생에서 따라 칩니다
      ### 확인
      …
    steps:               # 한 step = 재생되는 커밋 하나
      - message: "[1] main.rs — 시작"
        file: src/main.rs
        content: |       # 이 step 이 끝난 뒤의 파일 전체
          fn main() {}
      - message: "[1] 여러 파일"
        files:
          - { path: Cargo.toml, content: "..." }
          - { path: old.rs, delete: true }
branches:                # 선택: 단계 끝에서 갈라지는 실험
  - name: exp/try
    title: 일부러 실패하기
    after: "1"
    doc: |
    steps: [...]
```

- 설명의 `▶ \`경로\`` 줄이 말풍선을 나누는 기준입니다. 그 줄 앞의 글이 그 파일을 치기 시작할 때 뜨고, 마지막 표시 뒤의 글은 단계 마무리 말풍선이 됩니다.
- step 에는 diff 가 아니라 **파일 전체 내용**을 적습니다. 바뀐 부분은 재생할 때 계산합니다.
- 전체 정의는 `lib/sessions.mjs` 맨 위 주석에 있습니다.

## 화면에서 쓰는 법

1. 단계가 시작되면 말풍선에 "이 단계에서 할 일" 이 뜨고 재생이 멈춥니다. 읽고 **계속**(`Alt+Space`).
2. 재생이 새 파일로 넘어가면 내 코드도 같은 파일을 엽니다. 친 코드는 브라우저에 자동 저장됩니다.
3. **비교** 로 재생 코드와 diff 를 봅니다. 중간 단계부터 시작하면 시작 말풍선에 **앞 단계 코드 채우기** 가 나옵니다.
4. 단계 목록은 왼쪽 위 ☰, 설명 전체와 소개는 오른쪽 위 버튼, 설정(말풍선, 자동 멈춤, 따라 열기)은 ⚙.

| 키 | 동작 |
| --- | --- |
| `Alt+Space` | 재생 / 일시정지, 말풍선 계속 (에디터에서 치는 중에도) |
| `Alt+,` `Alt+.` | 한 줄 뒤로 / 앞으로 |
| `Alt+[` `Alt+]` | 이전 / 다음 커밋 |
| `Alt+-` `Alt+=` | 느리게 / 빠르게 |
| `[` `]` | 이전 / 다음 단계 (에디터 밖) |
| `?` | 단축키 목록 |

브라우저 안이라 빌드·실행·자동완성(rust-analyzer)은 없습니다. 빌드는 내 터미널에서 하세요.

## 정적 사이트로 배포 (선택)

```bash
pnpm export      # 세션 폴더 → public/data/*.json (publish: false 인 세션은 제외)
pnpm build       # dist/ 를 아무 정적 호스팅에 올리면 됩니다
```

main 에 push 하면 GitHub Actions 가 `public/data` 를 담아 Pages 로 배포합니다.
