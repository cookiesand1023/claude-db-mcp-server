# アーキテクチャ設計書

## 概要

Claude DB MCP Serverは、Claude CLIから自然言語でMySQLデータベースにクエリを実行するためのMCPサーバーシステムです。

## システム構成

### 全体アーキテクチャ

```
┌─────────────────────────────────────────────┐
│            Claude CLI (Desktop)             │
│                                             │
│  - 自然言語入力                             │
│  - SQL生成（Claude AI）                     │
│  - MCP Protocol通信                         │
└──────────────────┬──────────────────────────┘
                   │ stdio (MCP Protocol)
                   │
┌──────────────────▼──────────────────────────┐
│         MCP Server (Node.js)                │
│                                             │
│  [mcp-server/index.js]                     │
│  - MCP Protocol Handler                     │
│  - DB Config Loader (環境変数)              │
│  - Database Auto Detection                  │
│  - Query Safety Validator                   │
│  - MySQL Connection Pool Manager            │
└──────────────────┬──────────────────────────┘
                   │ mysql2/promise
                   │ (Connection Pool)
                   │
    ┌──────────────┼──────────────┐
    │              │              │
    ▼              ▼              ▼
┌────────┐    ┌────────┐    ┌────────┐
│  DB1   │    │  DB2   │    │  DB3   │
│        │    │        │    │        │
│ MySQL  │    │ MySQL  │    │ MySQL  │
│ (外部) │    │ (外部) │    │ (外部) │
└────────┘    └────────┘    └────────┘
```

## コンポーネント詳細

### 1. Claude CLI

**役割**: ユーザーインターフェース

- ユーザーからの自然言語入力を受け付け
- Claude AIでSQL生成
- MCP Protocolでサーバーと通信
- 結果を整形して表示

**技術スタック**:
- MCP SDK Client
- stdio通信

### 2. MCP Server

**役割**: DB接続・クエリ実行

**ファイル**: `index.ts`

**主要機能**:

#### a. 環境変数からDB設定読み込み

```javascript
// DB1_*, DB2_*, ... DB10_* の環境変数から動的に構築
function buildDbConfig(prefix) {
  const host = process.env[`${prefix}_HOST`];
  const database = process.env[`${prefix}_DATABASE`];

  if (!host || !database) return null;

  return {
    id: prefix.toLowerCase(),
    host,
    port: parseInt(process.env[`${prefix}_PORT`] || '3306'),
    user: process.env[`${prefix}_USER`] || 'root',
    password: process.env[`${prefix}_PASSWORD`] || '',
    database,
    keywords: process.env[`${prefix}_KEYWORDS`]?.split(',') || []
  };
}
```

#### b. スキーマ自動取得（起動時）

起動時に全DBのスキーマ情報を取得し、MCPツールのdescriptionに埋め込みます：

```javascript
async function loadDatabaseSchemas() {
  for (const [dbId, pool] of Object.entries(connectionPools)) {
    databaseSchemas[dbId] = { tables: {} };

    // テーブル一覧取得
    const [tables] = await pool.query('SHOW TABLES');

    for (const tableRow of tables) {
      const tableName = Object.values(tableRow)[0];

      // カラム情報取得
      const [columns] = await pool.query(`DESCRIBE ${tableName}`);

      // 外部キー取得
      const [foreignKeys] = await pool.query(`
        SELECT COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
        FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
          AND REFERENCED_TABLE_NAME IS NOT NULL
      `, [config.database, tableName]);

      // スキーマを保存
      databaseSchemas[dbId].tables[tableName] = { columns, foreignKeys };
    }
  }
}
```

#### c. スキーマ情報の提供

取得したスキーマ情報をMCPツールの`description`に動的に埋め込み、Claude AIに提供：

```javascript
function buildSchemaDescription() {
  return Object.entries(databaseSchemas).map(([dbId, schema]) => {
    const tables = Object.entries(schema.tables).map(([tableName, tableInfo]) => {
      const columns = tableInfo.columns.map(col => col.Field).join(', ');
      return `  - ${tableName}(${columns})`;
    }).join('\n');
    return `- ${dbId} (${dbConfigs[dbId].database}):\n${tables}`;
  }).join('\n\n');
}

// MCPツール定義
{
  name: 'query_database',
  description: `ユーザーの質問に対して適切なDBを判定しSQLを実行します。

【利用可能なデータベース】
${buildSchemaDescription()}

【注意】テーブル名・カラム名は上記を正確に参照してください`,
  inputSchema: {
    properties: {
      query: { type: 'string' },
      dbId: { type: 'string', description: '判定したデータベースID' },
      sql: { type: 'string' }
    },
    required: ['query', 'dbId', 'sql']
  }
}
```

#### d. データベース判定（Claude AIが実行）

**重要**: サーバー側での自動判定は行いません。Claude AI自身が判定します。

**Claude AIの判定プロセス**:
1. ツールのdescriptionからスキーマ情報を読む
2. ユーザーの質問を解析
3. 最適なdbIdを判定
4. 適切なSQLを生成
5. `query_database({ query, dbId, sql })`を呼び出し

**メリット**:
- Claude AIの強力な自然言語理解を活用
- 文脈を考慮した判定が可能
- 曖昧な質問にも対応
- 複数テーブルにまたがるクエリも適切に処理

#### f. クエリ安全性検証

危険な操作をブロック：

```javascript
function isDangerousQuery(sql) {
  const dangerous = /^\s*(DROP|DELETE|TRUNCATE|ALTER|UPDATE)\s+/i;
  return dangerous.test(sql.trim());
}
```

#### g. コネクションプール管理

```javascript
const connectionPools = {};

for (const [dbId, config] of Object.entries(dbConfigs)) {
  connectionPools[dbId] = mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  });
}
```

### 3. MCPツール定義

#### query_database

**説明**: Claude AIがDB判定してSQLを実行

**入力**:
- `query` (string): ユーザーの自然言語の質問
- `dbId` (string): Claude AIが判定したデータベースID ※必須
- `sql` (string): 実行するSQL

**処理フロー**:
1. dbIdが指定されているか確認
2. 指定されたdbIdが存在するか確認
3. SQLの危険性チェック
4. コネクションプールからDB接続取得
5. SQL実行
6. 結果を返却

**特徴**:
- Claude AIがツールのdescriptionからスキーマ情報を読み、自分で最適なDBを判定
- サーバー側での自動判定は不要

#### list_databases

**説明**: 利用可能なデータベース一覧

**入力**: なし

**出力**: DB設定一覧（id, database, keywords）

#### list_tables

**説明**: 指定DBのテーブル一覧

**入力**:
- `database` (string): データベースID

**処理**: `SHOW TABLES` を実行

#### describe_table

**説明**: テーブル構造取得

**入力**:
- `database` (string): データベースID
- `table` (string): テーブル名

**処理**: `DESCRIBE {table}` を実行

### 4. 外部データベース

**要件**:
- MySQL 5.7以上 / MySQL 8.0推奨
- ネットワークアクセス可能
- 読み取り権限を持つユーザー

**接続方法**:
- ホスト: localhost or リモートホスト
- ポート: 任意（デフォルト3306）
- 認証: ユーザー名/パスワード

## データフロー

### クエリ実行フロー（Claude AIによるDB判定）

```
0. 起動時
   loadDatabaseSchemas() → 全DBのテーブル・カラム情報を取得
   buildSchemaDescription() → MCPツールのdescriptionに埋め込み

1. ユーザー入力
   "メールアドレスがtest@example.comのユーザー情報を教えて"

2. Claude AIがツールのdescriptionを読む
   - db1: users(id, email, name, age), sessions(...)
   - db2: products(id, name, price), orders(...)
   → "usersテーブルにemailカラムがある → db1が適切"

3. Claude AIがDB判定してSQLを生成
   dbId: "db1"
   sql: "SELECT * FROM users WHERE email = 'test@example.com'"

4. MCP Server: query_database ツール呼び出し
   {
     query: "メールアドレスがtest@example.comのユーザー情報を教えて",
     dbId: "db1",
     sql: "SELECT * FROM users WHERE email = 'test@example.com'"
   }

5. サーバー側でdbIdを検証
   - dbIdが指定されているか
   - dbIdが存在するか

6. 安全性チェック
   isDangerousQuery() → false (SELECT文なのでOK)

7. SQL実行
   connectionPools['db1'].query(sql)

8. 結果返却
   {
     success: true,
     dbId: "db1",
     database: "my_database",
     rowCount: 5,
     results: [...]
   }

9. Claude CLIが結果を整形して表示
```

## セキュリティ

### 1. SQL Injection対策

- Prepared Statements使用（mysql2/promise）
- パラメータバインディング

### 2. 危険操作の制限

以下の操作を禁止：
- `DROP`: スキーマ/テーブル削除
- `DELETE`: データ削除
- `TRUNCATE`: テーブルクリア
- `ALTER`: スキーマ変更
- `UPDATE`: データ更新

### 3. 読み取り専用推奨

DBユーザーには`SELECT`権限のみ付与を推奨

```sql
CREATE USER 'readonly'@'%' IDENTIFIED BY 'password';
GRANT SELECT ON database_name.* TO 'readonly'@'%';
FLUSH PRIVILEGES;
```

## スケーラビリティ

### コネクションプール

- DB毎に独立したプール
- 最大10接続/DB
- 自動接続管理

### 複数DB対応

- 最大10個のDB（DB1〜DB10）
- 環境変数で動的設定
- ゼロダウンタイムで追加可能

## エラーハンドリング

### 1. DB接続エラー

```javascript
try {
  await pool.query(sql);
} catch (error) {
  return {
    success: false,
    error: error.message,
    code: error.code,
    sqlMessage: error.sqlMessage
  };
}
```

### 2. DB指定エラー

```javascript
// dbIdが指定されていない
if (!dbId) {
  return {
    content: [{
      type: 'text',
      text: `❌ データベースID（dbId）が指定されていません。\n利用可能: ${Object.keys(dbConfigs).join(', ')}`
    }]
  };
}

// dbIdが存在しない
if (!connectionPools[dbId]) {
  return {
    content: [{
      type: 'text',
      text: `❌ データベース "${dbId}" が見つかりません。\n利用可能: ${Object.keys(dbConfigs).join(', ')}`
    }]
  };
}
```

### 3. 危険操作検出

```javascript
if (isDangerousQuery(sql)) {
  return {
    content: [{
      type: 'text',
      text: '❌ 危険な操作は許可されていません'
    }]
  };
}
```

## 設定管理

### 環境変数仕様

| 変数 | 型 | 必須 | デフォルト | 説明 |
|------|-----|------|-----------|------|
| DB{N}_HOST | string | ✓ | - | DBホスト |
| DB{N}_PORT | number | | 3306 | DBポート |
| DB{N}_USER | string | | root | DBユーザー |
| DB{N}_PASSWORD | string | | '' | DBパスワード |
| DB{N}_DATABASE | string | ✓ | - | DB名 |
| DB{N}_KEYWORDS | string | | '' | 検索キーワード（カンマ区切り）※ |
| DISABLE_SCHEMA_LOADING | boolean | | false | スキーマ自動読み込みを無効化 |

※ N = 1〜10

※ **DB{N}_KEYWORDS**: スキーマ自動取得が有効な場合は省略可能。テーブル名・カラム名から自動生成されます。

### claude-config.json

```json
{
  "mcpServers": {
    "database": {
      "command": "node",
      "args": ["dist/index.js"]
    }
  }
}
```

環境変数は`.env`ファイルから自動的に読み込まれます。

## パフォーマンス

### 最適化ポイント

1. **コネクションプール**: 再利用で接続オーバーヘッド削減
2. **非同期処理**: async/await で並列実行可能
3. **キャッシュ不要**: ステートレス設計

### ボトルネック

1. **DB応答時間**: 外部DBの性能に依存
2. **ネットワーク遅延**: リモートDB接続時

## 拡張性

### 実装済み拡張機能

1. **スキーマ自動取得**: 起動時に全DBのテーブル・カラム構造を取得
2. **動的ツール説明文**: スキーマ情報をMCPツールのdescriptionに埋め込み
3. **Claude AIによるDB判定**: AIの自然言語理解を活用した高精度な判定

### 将来の拡張案

1. **PostgreSQL対応**: mysql2 → pg に変更
2. **Redis対応**: スキーマキャッシュ・クエリキャッシュ
3. **クエリログ**: 実行履歴記録
4. **権限管理**: ユーザー毎のDB制限
5. **レートリミット**: クエリ実行回数制限
6. **スキーマ変更検知**: 定期的にスキーマを再読み込み

## 運用

### モニタリング

- コネクションプール状態
- クエリ実行時間
- エラー率

### ログ

```javascript
console.error('Claude DB MCP Server running on stdio');
console.error('Error:', error.message);
```

## まとめ

Claude DB MCP Serverは、シンプルで安全、かつ拡張性の高いアーキテクチャを採用しています。環境変数ベースの設定により、既存DBへの接続が容易で、MCPプロトコルによりClaude CLIとシームレスに統合されます。
