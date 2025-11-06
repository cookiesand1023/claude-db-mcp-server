# Claude DB MCP Server

Claude Codeから自然言語でデータベースにクエリを実行するMCPサーバー。

## 概要

既存のMySQLデータベースに接続し、Claude Codeから自然言語でSQLクエリを実行できるMCPサーバーです。

### 特徴

- **環境変数で柔軟に設定**: 最大10個のDBを`DB1_*`, `DB2_*`...で定義可能
- **既存DBに接続**: ローカルまたはリモートのMySQLデータベースへ接続
- **自動スキーマ読み込み**: テーブル構造を自動取得し、Claude AIが適切なクエリを生成
- **安全性**: 危険な操作（DROP/DELETE/UPDATE等）を自動ブロック

## アーキテクチャ

```
┌─────────────────┐
│  Claude Code    │ ← 自然言語で質問
└────────┬────────┘
         │ MCP Protocol
         ▼
┌─────────────────────────────┐
│  MCP Server (index.js)      │
│  - スキーマ自動読み込み     │
│  - SQL生成・実行            │
│  - 危険操作ブロック         │
└────────┬───────┬────────┬───┘
         │       │        │
         ▼       ▼        ▼
    ┌────────┐ ┌────────┐ ┌────────┐
    │  DB1   │ │  DB2   │ │  DB3   │
    │(MySQL) │ │(MySQL) │ │(MySQL) │
    └────────┘ └────────┘ └────────┘
```

## クイックスタート

### 1. 環境変数を設定

```bash
cp .env.example .env
vi .env  # データベースの接続情報を設定
```

`.env` 例（最大10個まで設定可能）：
```bash
# Database 1
DB1_HOST=localhost
DB1_PORT=3306
DB1_USER=your_username
DB1_PASSWORD=your_password
DB1_DATABASE=database1

# Database 2
DB2_HOST=localhost
DB2_PORT=3306
DB2_USER=your_username
DB2_PASSWORD=your_password
DB2_DATABASE=database2

# 必要に応じてDB3, DB4... を追加
```

### 2. 依存関係をインストールしてビルド

```bash
npm install
npm run build
```

### 3. Claude Codeで使用

Claude Codeを起動すると、自動的にMCPサーバーが読み込まれます。

起動確認：
```bash
/mcp
```

成功すると以下のツールが利用可能になります：
- `query_database`: データベースクエリ実行
- `list_databases`: データベース一覧表示
- `list_tables`: テーブル一覧表示
- `describe_table`: テーブル構造表示

## 使用例

Claude Code内で自然言語で質問するだけで、Claude AIが適切なデータベースを判定してクエリを実行します。

### 基本的な使い方

```
メールアドレスがtest@example.comのユーザー情報を教えて
```

**Claude AIが自動的に：**
1. スキーマ情報からDB判定（usersテーブルにemailカラムがあるデータベースを特定）
2. SQLクエリ生成（`SELECT * FROM users WHERE email = 'test@example.com'`）
3. クエリ実行・結果表示

### その他の例

```
# シンプルなクエリ
ユーザーの名前を全部見せて

# 集計クエリ
ユーザー数を教えて

# 複数テーブルのJOIN
ユーザーごとの注文数を教えて

# 条件付き検索
公開設定がtrueのユーザーを表示

# テーブル一覧確認
DB1にどんなテーブルがある？

# テーブル構造確認
usersテーブルの構造を教えて
```

## 利用可能なツール

| ツール名 | 説明 |
|---------|------|
| `query_database` | 自然言語からSQLクエリを生成・実行 |
| `list_databases` | 接続可能なデータベース一覧を表示 |
| `list_tables` | 指定したデータベースのテーブル一覧を表示 |
| `describe_table` | 指定したテーブルの構造を表示 |

## 主な機能

### 自動スキーマ読み込み

起動時に接続されたデータベースのスキーマ情報（テーブル、カラム、外部キー）を自動的に読み込みます。

- テーブル構造の自動解析
- 外部キー関係の把握
- Claude AIへのスキーマ情報提供

### Claude AIによる高精度なクエリ生成

スキーマ情報を元に、Claude AIが自然言語から適切なSQLクエリを生成：

- **文脈理解**: 曖昧な質問でも意図を汲み取る
- **複雑なクエリ**: 複数テーブルのJOINも適切に生成
- **高精度**: テーブル名・カラム名を正確に参照

## 環境変数

| 変数名 | 必須 | 説明 | デフォルト |
|--------|------|------|-----------|
| `DB{N}_HOST` | ✓ | データベースホスト名 | - |
| `DB{N}_PORT` | | データベースポート | 3306 |
| `DB{N}_USER` | | データベースユーザー名 | root |
| `DB{N}_PASSWORD` | | データベースパスワード | (空) |
| `DB{N}_DATABASE` | ✓ | データベース名 | - |
| `DISABLE_SCHEMA_LOADING` | | スキーマ自動読み込みを無効化 | false |

※ `{N}` は 1〜10 の数字

## 安全性

以下の操作は自動ブロック：
- `DROP`, `DELETE`, `TRUNCATE`, `ALTER`, `UPDATE`

SELECT文のみ実行可能です。

## プロジェクト構成

```
claude-db-mcp-server/
├── .env                    # 環境変数（要作成）
├── .env.example            # 環境変数テンプレート
├── .gitignore
├── README.md               # このファイル
├── claude-config.json      # Claude Code MCP設定
├── index.ts                # MCPサーバー（TypeScript）
├── tsconfig.json           # TypeScript設定
├── package.json            # 依存関係
└── dist/                   # ビルド済みJS（自動生成）
    └── index.js
```

## 必要要件

- Node.js 18.0.0以上
- MySQL 5.7以上
- Claude Code（MCP対応版）

## ライセンス

MIT
