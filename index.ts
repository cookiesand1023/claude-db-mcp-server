#!/usr/bin/env node

import dotenv from 'dotenv';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import mysql, { Pool, RowDataPacket } from 'mysql2/promise';

// Load environment variables from .env file
dotenv.config();

// 型定義
interface DbConfig {
  id: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

interface ColumnInfo {
  Field: string;
  Type: string;
  Null: string;
  Key: string;
  Default: string | null;
  Extra: string;
}

interface ForeignKeyInfo {
  COLUMN_NAME: string;
  REFERENCED_TABLE_NAME: string;
  REFERENCED_COLUMN_NAME: string;
}

interface TableInfo {
  columns: ColumnInfo[];
  foreignKeys: ForeignKeyInfo[];
}

interface DatabaseSchema {
  tables: Record<string, TableInfo>;
}

// 環境変数からDB設定を動的に構築
function buildDbConfig(prefix: string): DbConfig | null {
  const host = process.env[`${prefix}_HOST`];
  const database = process.env[`${prefix}_DATABASE`];

  if (!host || !database) {
    return null;
  }

  return {
    id: prefix.toLowerCase(),
    host,
    port: parseInt(process.env[`${prefix}_PORT`] || '3306'),
    user: process.env[`${prefix}_USER`] || 'root',
    password: process.env[`${prefix}_PASSWORD`] || '',
    database
  };
}

// DB1, DB2, DB3... の環境変数から設定を読み込み
const dbConfigs: Record<string, DbConfig> = {};
for (let i = 1; i <= 10; i++) {
  const prefix = `DB${i}`;
  const config = buildDbConfig(prefix);
  if (config) {
    dbConfigs[config.id] = config;
  }
}

// 設定が1つもない場合はエラー
if (Object.keys(dbConfigs).length === 0) {
  console.error('Error: No database configurations found. Please set DB1_HOST, DB1_DATABASE, etc.');
  process.exit(1);
}

// データベース接続プール
const connectionPools: Record<string, Pool> = {};

// 接続プール初期化
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

// スキーマ情報を格納
const databaseSchemas: Record<string, DatabaseSchema> = {};

// スキーマ自動取得機能
async function loadDatabaseSchemas(): Promise<void> {
  console.error('📊 Loading database schemas...');

  for (const [dbId, pool] of Object.entries(connectionPools)) {
    try {
      databaseSchemas[dbId] = {
        tables: {}
      };

      // テーブル一覧取得
      const [tables] = await pool.query<RowDataPacket[]>('SHOW TABLES');

      for (const tableRow of tables) {
        const tableName = Object.values(tableRow)[0] as string;

        // カラム情報取得
        const [columns] = await pool.query<ColumnInfo[] & RowDataPacket[]>(`DESCRIBE ${tableName}`);

        // 外部キー取得
        const [foreignKeys] = await pool.query<ForeignKeyInfo[] & RowDataPacket[]>(`
          SELECT
            COLUMN_NAME,
            REFERENCED_TABLE_NAME,
            REFERENCED_COLUMN_NAME
          FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
          WHERE TABLE_SCHEMA = ?
            AND TABLE_NAME = ?
            AND REFERENCED_TABLE_NAME IS NOT NULL
        `, [dbConfigs[dbId].database, tableName]);

        databaseSchemas[dbId].tables[tableName] = {
          columns,
          foreignKeys
        };
      }

      console.error(`  ✅ ${dbId}: ${Object.keys(databaseSchemas[dbId].tables).length} tables`);
    } catch (error) {
      const err = error as Error;
      console.error(`  ❌ ${dbId}: Failed to load schema - ${err.message}`);
      databaseSchemas[dbId] = { tables: {} };
    }
  }

  console.error('✅ Schema loading complete\n');
}

// 危険なSQL操作を検出
function isDangerousQuery(sql: string): boolean {
  const dangerous = /^\s*(DROP|DELETE|TRUNCATE|ALTER|UPDATE)\s+/i;
  return dangerous.test(sql.trim());
}

// テーブル構造取得
async function getTableSchema(dbId: string, tableName: string): Promise<ColumnInfo[]> {
  const pool = connectionPools[dbId];
  const [columns] = await pool.query<ColumnInfo[] & RowDataPacket[]>(`DESCRIBE ${tableName}`);
  return columns;
}

// データベース内のテーブル一覧取得
async function listTables(dbId: string): Promise<string[]> {
  const pool = connectionPools[dbId];
  const [tables] = await pool.query<RowDataPacket[]>('SHOW TABLES');
  return tables.map(t => Object.values(t)[0] as string);
}

// スキーマ情報を整形してツールのdescriptionに含める
function buildSchemaDescription(): string {
  if (Object.keys(databaseSchemas).length === 0) {
    // スキーマが読み込まれていない場合
    return Object.entries(dbConfigs).map(([id, config]) => {
      return `- ${id} (${config.database})`;
    }).join('\n');
  }

  // スキーマ情報がある場合
  return Object.entries(databaseSchemas).map(([dbId, schema]) => {
    const tables = Object.entries(schema.tables).map(([tableName, tableInfo]) => {
      const columns = tableInfo.columns.map(col => col.Field).join(', ');
      return `  - ${tableName}(${columns})`;
    }).join('\n');
    return `- ${dbId} (${dbConfigs[dbId].database}):\n${tables}`;
  }).join('\n\n');
}

// MCPサーバー作成
const server = new Server(
  {
    name: 'claude-db-mcp-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// ツール一覧
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const schemaInfo = buildSchemaDescription();

  return {
    tools: [
      {
        name: 'query_database',
        description: `ユーザーの自然言語の質問に対して、適切なデータベースを判定し、SQLクエリを実行します。

【重要】以下の利用可能なデータベース情報を参考に、質問内容に最も適したデータベースID（dbId）を判定し、適切なSQLクエリを生成してください。

【利用可能なデータベース】
${schemaInfo}

【注意事項】
- SELECT文のみ実行可能です
- テーブル名・カラム名は上記スキーマ情報を正確に参照してください
- 複数のテーブルにまたがる場合はJOINを使用してください`,
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'ユーザーの自然言語での質問',
            },
            dbId: {
              type: 'string',
              description: '判定したデータベースID（db1, db2, db3など）',
            },
            sql: {
              type: 'string',
              description: '実行するSQLクエリ（SELECT文のみ）',
            },
          },
          required: ['query', 'dbId', 'sql'],
        },
      },
      {
        name: 'list_databases',
        description: '利用可能なデータベースの一覧を取得します',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'list_tables',
        description: '指定したデータベース内のテーブル一覧を取得します',
        inputSchema: {
          type: 'object',
          properties: {
            database: {
              type: 'string',
              description: `データベースID（${Object.keys(dbConfigs).join('/')}）`,
            },
          },
          required: ['database'],
        },
      },
      {
        name: 'describe_table',
        description: '指定したテーブルの構造を取得します',
        inputSchema: {
          type: 'object',
          properties: {
            database: {
              type: 'string',
              description: `データベースID（${Object.keys(dbConfigs).join('/')}）`,
            },
            table: {
              type: 'string',
              description: 'テーブル名',
            },
          },
          required: ['database', 'table'],
        },
      },
    ],
  };
});

// ツール実行ハンドラ
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'query_database': {
        const { query, dbId, sql } = args as { query: string; dbId: string; sql: string };

        // dbIdが指定されているか確認
        if (!dbId) {
          return {
            content: [
              {
                type: 'text',
                text: `❌ データベースID（dbId）が指定されていません。\n\n利用可能なデータベース：${Object.keys(dbConfigs).join(', ')}`,
              },
            ],
          };
        }

        // 指定されたdbIdが存在するか確認
        if (!connectionPools[dbId]) {
          return {
            content: [
              {
                type: 'text',
                text: `❌ データベース "${dbId}" が見つかりません。\n\n利用可能なデータベース：${Object.keys(dbConfigs).join(', ')}`,
              },
            ],
          };
        }

        // 危険なクエリチェック
        if (isDangerousQuery(sql)) {
          return {
            content: [
              {
                type: 'text',
                text: '❌ 危険な操作（DROP/DELETE/TRUNCATE/ALTER/UPDATE）は許可されていません。\n\nSELECT文のみ実行可能です。',
              },
            ],
          };
        }

        // SQL実行
        const pool = connectionPools[dbId];
        const [rows] = await pool.query<RowDataPacket[]>(sql);

        const resultText = `✅ データベース: ${dbConfigs[dbId].database} (${dbId})\n📊 取得件数: ${Array.isArray(rows) ? rows.length : 0}件\n\n${JSON.stringify(rows, null, 2)}`;

        return {
          content: [
            {
              type: 'text',
              text: resultText,
            },
          ],
        };
      }

      case 'list_databases': {
        const dbList = Object.entries(dbConfigs).map(([id, config]) => ({
          id,
          database: config.database,
          host: config.host,
          port: config.port,
        }));

        return {
          content: [
            {
              type: 'text',
              text: `📊 利用可能なデータベース:\n\n${JSON.stringify(dbList, null, 2)}`,
            },
          ],
        };
      }

      case 'list_tables': {
        const { database } = args as { database: string };
        const dbId = database.toLowerCase();

        if (!connectionPools[dbId]) {
          return {
            content: [
              {
                type: 'text',
                text: `❌ データベース "${database}" が見つかりません。利用可能: ${Object.keys(dbConfigs).join(', ')}`,
              },
            ],
          };
        }

        const tables = await listTables(dbId);

        return {
          content: [
            {
              type: 'text',
              text: `📋 ${dbConfigs[dbId].database} のテーブル一覧:\n\n${tables.join('\n')}`,
            },
          ],
        };
      }

      case 'describe_table': {
        const { database, table } = args as { database: string; table: string };
        const dbId = database.toLowerCase();

        if (!connectionPools[dbId]) {
          return {
            content: [
              {
                type: 'text',
                text: `❌ データベース "${database}" が見つかりません。利用可能: ${Object.keys(dbConfigs).join(', ')}`,
              },
            ],
          };
        }

        const schema = await getTableSchema(dbId, table);

        return {
          content: [
            {
              type: 'text',
              text: `📋 ${dbConfigs[dbId].database}.${table} のテーブル構造:\n\n${JSON.stringify(schema, null, 2)}`,
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const err = error as Error;
    return {
      content: [
        {
          type: 'text',
          text: `❌ エラー: ${err.message}`,
        },
      ],
      isError: true,
    };
  }
});

// サーバー起動
async function main(): Promise<void> {
  // スキーマを読み込み（環境変数でスキップ可能）
  if (process.env.DISABLE_SCHEMA_LOADING !== 'true') {
    try {
      await loadDatabaseSchemas();
    } catch (error) {
      const err = error as Error;
      console.error('⚠️  Schema loading failed:', err.message);
    }
  } else {
    console.error('⚠️  Schema loading disabled by DISABLE_SCHEMA_LOADING=true');
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('✅ Claude DB MCP Server running on stdio');
}

main().catch((error: Error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
