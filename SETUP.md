# セットアップガイド

## 前提条件

### 必須

- **Node.js**: 18以上
- **Claude CLI**: インストール済み（Maxプラン）
- **既存のMySQLデータベース**: 別コンテナまたはリモートで稼働中

### 確認方法

```bash
# Node.jsバージョン確認
node --version  # v18.0.0以上

# Claude CLIインストール確認
claude --version
```

Claude CLIが未インストールの場合：
```bash
npm install -g @anthropic-ai/claude-cli
```

## セットアップ手順

### ステップ1: リポジトリのクローン

```bash
git clone <repository-url>
cd claude-db-mcp-server
```

### ステップ2: 環境変数ファイルの作成

```bash
cp .env.example .env
```

`.env`を編集して既存DBの接続情報を設定：

```bash
vi .env
```

#### 設定例

**1つのDBの場合：**

```bash
# Database 1
DB1_HOST=localhost
DB1_PORT=3306
DB1_USER=root
DB1_PASSWORD=mypassword
DB1_DATABASE=my_database
```

**複数DBの場合：**

```bash
# Database 1: 認証DB
DB1_HOST=localhost
DB1_PORT=3306
DB1_USER=auth_user
DB1_PASSWORD=auth_pass
DB1_DATABASE=auth_db

# Database 2: ショップDB
DB2_HOST=localhost
DB2_PORT=3307
DB2_USER=shop_user
DB2_PASSWORD=shop_pass
DB2_DATABASE=shop_db

# Database 3: 分析DB
DB3_HOST=192.168.1.100
DB3_PORT=3306
DB3_USER=analytics_user
DB3_PASSWORD=analytics_pass
DB3_DATABASE=analytics_db

# Database 4, 5... 最大DB10まで
```

#### 環境変数の説明

| 変数名 | 必須 | 説明 | 例 |
|--------|------|------|-----|
| `DB{N}_HOST` | ✓ | DBホスト名またはIP | `localhost`, `192.168.1.100` |
| `DB{N}_PORT` | | DBポート（デフォルト: 3306） | `3306`, `3307` |
| `DB{N}_USER` | | DBユーザー（デフォルト: root） | `dbuser` |
| `DB{N}_PASSWORD` | | DBパスワード（デフォルト: 空） | `password123` |
| `DB{N}_DATABASE` | ✓ | データベース名 | `my_database` |
| `DISABLE_SCHEMA_LOADING` | | スキーマ自動取得を無効化 | `false` |

※ `{N}` は 1〜10 の数字
※ **DB{N}_KEYWORDS**: スキーマ自動取得により不要（Claude AIがテーブル・カラム名から判定）

### ステップ3: 依存関係インストールとビルド

```bash
npm install
npm run build
```

**注意**: TypeScript実装のため、初回は必ず`npm run build`を実行してください。

### ステップ5: Claude CLIでMCPサーバーを起動

```bash
claude --mcp-config $(pwd)/claude-config.json
```

起動成功すると以下のメッセージが表示されます：

```
Connected to MCP server: claude-db-mcp-server
Available tools: query_database, list_databases, list_tables, describe_table
```

## 使い方

### 基本的なクエリ

```
あなた: DB1のusersテーブルを見せて
```

Claudeが自動的に：
1. DB1を判定
2. SQLを生成（`SELECT * FROM users LIMIT 10;`）
3. クエリを実行
4. 結果を表示

### データベース情報の確認

```
あなた: 利用可能なデータベースを教えて
```

出力例：
```
📊 利用可能なデータベース:

[
  {
    "id": "db1",
    "database": "auth_db",
    "keywords": ["auth", "user", "login", "session"]
  },
  {
    "id": "db2",
    "database": "shop_db",
    "keywords": ["shop", "product", "order", "cart"]
  }
]
```

### テーブル一覧の確認

```
あなた: DB1のテーブル一覧を見せて
```

### テーブル構造の確認

```
あなた: DB1のusersテーブルの構造を教えて
```

## トラブルシューティング

### 1. 環境変数が読み込まれない

**症状**: `Error: No database configurations found`

**原因**: `.env`ファイルが正しく読み込まれていない

**解決策**:
```bash
# .envファイルの存在確認
ls -la .env

# 環境変数の読み込み確認
source .env && echo $DB1_HOST
```

`claude-config.json`を確認し、envフィールドを修正：

```json
{
  "mcpServers": {
    "database": {
      "command": "node",
      "args": ["dist/index.js"],
      "env": {
        "DB1_HOST": "localhost",
        "DB1_DATABASE": "my_database"
      }
    }
  }
}
```

### 2. DB接続エラー

**症状**: `Error: connect ECONNREFUSED`

**原因**: DBサーバーに接続できない

**解決策**:

1. DBサーバーが起動しているか確認
```bash
# MySQLプロセス確認
ps aux | grep mysql

# Dockerコンテナ確認
docker ps | grep mysql
```

2. ホスト・ポート設定を確認
```bash
# ローカルDB
DB1_HOST=localhost

# Dockerコンテナ（Mac/Windows）
DB1_HOST=host.docker.internal

# リモートDB
DB1_HOST=192.168.1.100
```

3. ファイアウォール設定を確認

### 3. 認証エラー

**症状**: `Error: Access denied for user`

**原因**: ユーザー名・パスワードが間違っている

**解決策**:

```bash
# MySQLで直接接続テスト
mysql -h localhost -u root -p

# ユーザー権限確認
mysql -e "SELECT user, host FROM mysql.user;"
```

必要に応じてユーザーを作成：

```sql
CREATE USER 'dbuser'@'%' IDENTIFIED BY 'password';
GRANT SELECT ON database_name.* TO 'dbuser'@'%';
FLUSH PRIVILEGES;
```

### 4. データベースが特定できない

**症状**: `❌ データベースが見つかりません`

**原因**: Claude AIが適切なDBを判定できない

**解決策**:

1. データベース名を明示的に指定
```
あなた: DB1のusersテーブルを見せて
```

2. スキーマ自動取得が有効か確認
```bash
# .envでDISABLE_SCHEMA_LOADINGが設定されていないことを確認
cat .env | grep DISABLE_SCHEMA_LOADING
```

### 5. Claude CLIがMCPサーバーを認識しない

**症状**: `MCP server not found`

**原因**: `claude-config.json`のパスが間違っている

**解決策**:

1. 絶対パスで指定
```bash
claude --mcp-config /full/path/to/claude-db-mcp-server/claude-config.json
```

2. `claude-config.json`の内容を確認
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

3. dist/index.jsのパスが正しいか確認（ビルド済みか）
```bash
ls -la dist/index.js
```

ビルドされていない場合：
```bash
npm run build
```

## セキュリティ設定

### 読み取り専用ユーザーの作成（推奨）

```sql
-- 読み取り専用ユーザーを作成
CREATE USER 'readonly'@'%' IDENTIFIED BY 'secure_password';

-- SELECT権限のみ付与
GRANT SELECT ON my_database.* TO 'readonly'@'%';

-- 権限を反映
FLUSH PRIVILEGES;
```

`.env`に設定：
```bash
DB1_USER=readonly
DB1_PASSWORD=secure_password
```

### パスワードの安全な管理

1. `.env`ファイルを`.gitignore`に追加（既に追加済み）
2. 環境変数を暗号化（本番環境）

```bash
# AWS Secrets Manager, Vault等を使用
```

## Docker環境での実行（オプション）

### MCPサーバーをDockerで起動

```bash
# .envファイルを作成
cp .env.example .env
vi .env  # 接続情報を設定

# Dockerコンテナをビルド・起動
docker-compose up -d

# ログ確認
docker-compose logs -f
```

**注意**: Claude CLIはホストマシンで動作するため、通常はDockerは不要です。

## よくある質問

### Q1: 複数のDBを同時にクエリできますか？

A: いいえ。1つのクエリで1つのDBのみ実行できます。複数DBのデータを結合したい場合は、それぞれクエリを実行してClaude側で結合してください。

### Q2: PostgreSQLに対応していますか？

A: 現在はMySQL/MariaDBのみ対応しています。PostgreSQL対応は将来の拡張予定です。

### Q3: SELECT以外のクエリを実行できますか？

A: セキュリティのため、SELECT文のみ実行可能です。INSERT/UPDATE/DELETE等は自動的にブロックされます。

### Q4: リモートDBに接続できますか？

A: はい。`DB{N}_HOST`にIPアドレスまたはホスト名を指定してください。

### Q5: 環境変数なしで実行できますか？

A: いいえ。最低1つのDB設定（`DB1_HOST`, `DB1_DATABASE`）が必須です。

### Q6: ビルドエラーが出ます

A: 以下を確認してください：

```bash
# Node.jsバージョン確認（18以上が必要）
node --version

# 依存関係を再インストール
rm -rf node_modules package-lock.json
npm install

# 再ビルド
npm run build
```

## 開発モード

TypeScriptの変更を監視してリアルタイムでビルド：

```bash
npm run dev
```

別のターミナルでClaude CLIを起動すれば、コード変更が反映されます。

## 次のステップ

- [ARCHITECTURE.md](./ARCHITECTURE.md) でシステム設計を理解
- [README.md](./README.md) で使用例を確認
- 実際にClaude CLIで自然言語クエリを試す

## サポート

問題が解決しない場合は、以下を確認してください：

1. Node.jsバージョン: `node --version` (18以上)
2. TypeScriptビルド: `npm run build`
3. ビルド成果物: `ls -la dist/index.js`
4. 環境変数: `cat .env`
5. DB接続テスト: `mysql -h ... -u ... -p`
6. MCPサーバーログ: Claude CLI起動時のエラーメッセージ

詳細はIssueで報告してください。
