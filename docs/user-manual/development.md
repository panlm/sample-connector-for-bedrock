# Development

This project mainly provides sample code, and it is strongly recommended that you develop it yourself with reference to this project.

## Local Development

### installation

Clone the repository.

This project uses [pnpm](https://pnpm.io) as its package manager (pinned via
`packageManager: pnpm@10.34.5` in `package.json`). Internal scripts such as
`build` and `build-server` call `pnpm run`, so mixing in `npm`/`yarn` is not
supported.

Install dependencies:

```shell
pnpm install
```

### Environment

the .env file

 Place it in the root directory of the project.

 ```env
 PGSQL_HOST=127.0.0.1
 PGSQL_DATABASE=brconnector_db
 PGSQL_USER=postgres
 PGSQL_PASSWORD=mysecretpassword
 PGSQL_DEBUG_MODE=ok
 ADMIN_API_KEY=br_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
 DEBUG_MODE=true
 ```

The connector supports the following environment variables:

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
| PERFORMANCE_MODE | no |  | If you set this environment variable, then chat logs and billing updates will no longer be saved. This means the cost control feature will be disabled.|

### Run backend

 ```shell
 pnpm dev
 ```

 If you have configured postgres, the tables will be created automatically.

### Run fontend

 ```shell
 pnpm dev-ui
 ```

## Tests and lint

```shell
pnpm test      # run the unit test suite (vitest run)
pnpm lint      # blocking lint gate — must exit 0
pnpm lint:ui   # frontend lint baseline (reports issues, exits non-zero)
```

See the **Development → Tests / Lint** sections of the repository `README.md`
for the full baseline (suite layout, the lint ratchet, and its current numbers).

## Build

### Build the backend and frontend together

```shell
pnpm build
```

The above command will compile the frontend and backend applications into the dist/frontend and dist/server directories, respectively.

After a successful compilation, navigate to the dist directory and execute `node server/index.js`.

If you have not disabled the WebUI, <http://localhost:8866/manager> will be bound to the WebUI.

### Build back-end (Option)

```shell
pnpm build-server
```

### Build front-end (Option)

```shell
pnpm build-ui
```

### Build Docker image

After building, use the `Dockerfile` already provided in the repository root to
build the image — you do not need to create one. It is based on
`public.ecr.aws/docker/library/node:22-slim`, copies the built `./dist` into the
image, runs `npm install --omit=dev`, and starts `node server/index.js`.

Then execute the following command from the repository root:

```shell
docker build -t <registry-repo-tag> .
```
