FROM node:20-alpine

WORKDIR /app

# パッケージファイルをコピー
COPY package*.json ./
COPY tsconfig.json ./

# 依存関係をインストール
RUN npm install

# ソースコードをコピー
COPY *.ts ./

# TypeScriptをビルド
RUN npm run build

# 実行
CMD ["node", "dist/index.js"]
