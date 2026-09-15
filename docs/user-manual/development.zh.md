# 开发指南

本项目是示例代码，强烈建议您参考本项目自行开发。

## 本地开发模式

Clone 本项目。

本项目使用 [pnpm](https://pnpm.io) 作为包管理器（在 `package.json` 中通过
`packageManager: pnpm@10.34.5` 固定版本）。`build`、`build-server` 等内部脚本会
调用 `pnpm run`，因此不支持混用 `npm`/`yarn`。

安装依赖：

```shell
pnpm install
```

### 环境变量配置

.env 文件

> 这个文件放在项目根目录.

 ```env
 PGSQL_HOST=127.0.0.1
 PGSQL_DATABASE=brconnector_db
 PGSQL_USER=postgres
 PGSQL_PASSWORD=mysecretpassword
 PGSQL_DEBUG_MODE=ok
 ADMIN_API_KEY=br_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
 DEBUG_MODE=true
 ```

 支持如下环境变量：

| Key      | Required     | Default value | Description |
| ------------- | ------------- | ------------- | ------------- |
| ADMIN_API_KEY | yes  | | You need to set this value to generate the first API key. |
| PGSQL_HOST | no | | The address of the PostgreSQL. If the database is not configured, then the connector is just a pure proxy.|
| PGSQL_PORT | no | 5432 | The port of the PostgreSQL. |
| PGSQL_DATABASE | no | | The name of the PostgreSQL database. |
| PGSQL_USER | no | | The login user for the PostgreSQL. |
| PGSQL_PASSWORD | no | | The password user for the PostgreSQL. |
| PGSQL_MAX |  no | 80 | The maximum connection pool size for PostgreSQL.|
| PGSQL_DEBUG_MODE | no | false | If you set this parameter, it will print out the SQL statements and parameters in the console. |
| AWS_ACCESS_KEY_ID | no  | | If your application has been authorized through an IAM policy, you don't need to set this variable. |
| AWS_SECRET_ACCESS_KEY | no | | If your application has been authorized through an IAM policy, you don't need to set this variable. |
| AWS_DEFAULT_REGION | no | 'us-east-1' | |
| DEBUG_MODE | no |  false | If you set this parameter, it will print out a lot of debugging information in the console. |
| DISABLE_UI | no | false | Setting this value will not publish the front-end UI.|
| SMTP_HOST | no |  | SMTP server host address. Setting up an SMTP Server allows you to send your API key directly to the user's email inbox. |
| SMTP_PORT | no | 465 | SMTP server port number |
| SMTP_USER | no |  | SMTP server username |
| SMTP_PASS | no |  |  SMTP server password |
| SMPT_FROM | no |  | SMTP sender email address, your SMTP server maybe verify this |
| PERFORMANCE_MODE | no |  | 如果您设置了这个环境变量，那么将不再保存聊天记录和更新消费了。意味着控费功能将失效。 |

### 启动后台

 ```shell
 pnpm dev
 ```

 If you have configured postgres, the tables will be created automatically.

### 启动管理界面

 ```shell
 pnpm dev-ui
 ```

## 测试与 lint

```shell
pnpm test      # 运行单元测试套件（vitest run）
pnpm lint      # 阻塞式 lint 门禁 —— 必须退出码为 0
pnpm lint:ui   # 前端 lint 基线（会报告问题，退出码非 0）
```

完整基线（套件结构、lint ratchet 及当前数字）见仓库 `README.md` 的
**Development → Tests / Lint** 章节。

## 构建

### 一起构建

```shell
pnpm build
```

The above command will compile the frontend and backend applications into the dist/frontend and dist/server directories, respectively.

After a successful compilation, navigate to the dist directory and execute `node server/index.js`.

If you have not disabled the WebUI, <http://localhost:8866/manager> will be bound to the WebUI.

### 构建后端 (可选)

```shell
pnpm build-server
```

### 构建前端 (可选)

```shell
pnpm build-ui
```

### Docker 镜像

编译完成之后，直接使用仓库根目录中**已有的** `Dockerfile` 构建镜像，无需自行创建。
该 Dockerfile 基于 `public.ecr.aws/docker/library/node:22-slim`，将构建产物 `./dist`
拷入镜像，执行 `npm install --omit=dev`，并以 `node server/index.js` 启动。

然后在仓库根目录执行打包命令：

```shell
docker build -t <registry-repo-tag> .
```
