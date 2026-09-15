# Sample Connector for Bedrock

This is a Bedrock (and other generative AI tools from AWS) API forwarding tool that can issue virtual keys, log chats, and manage costs.

It is compatible with any OPENAI client or Anthropic client that can define Host and API Key.

## Quick references

[Quick start](https://aws-samples.github.io/sample-connector-for-bedrock/home/quick-start/)

[Quick Deployment](https://aws-samples.github.io/sample-connector-for-bedrock/home/deployment/)

[Providers](https://aws-samples.github.io/sample-connector-for-bedrock/providers/introduction/)

Docker Image: [DockerHub](https://hub.docker.com/r/cloudbeer/sample-connector-for-bedrock/tags), [Public ECR](https://gallery.ecr.aws/x6u9o2u4/sample-connector-for-bedrock)

Docker Image for Lambda: [DockerHub](https://hub.docker.com/r/cloudbeer/sample-connector-for-bedrock-lambda/tags), [Public ECR](https://gallery.ecr.aws/x6u9o2u4/sample-connector-for-bedrock-lambda)

## Development

This project uses [pnpm](https://pnpm.io) as its package manager (pinned via
`packageManager: pnpm@10.34.5` in `package.json`). Use `pnpm` for all
dependency and script commands — internal scripts (`build`, `build-server`)
call `pnpm run`, so mixing in `npm`/`yarn` is not supported.

```bash
pnpm install   # install dependencies
pnpm test      # run unit tests (vitest run)
pnpm lint      # blocking gate: lint everything except src-frontend/** (must exit 0)
pnpm lint:ui   # cleanup baseline: lint src-frontend/** (reports 26/355, exits non-zero)
pnpm lint:all  # informational: lint the whole repo (exit 1 until frontend is clean)
pnpm build     # build server + UI (build-server && build-ui)
```

### Tests

`pnpm test` runs [Vitest](https://vitest.dev) (`vitest run`). The current suite
(6 files, 29 cases) covers:

- `test/helper.test.ts` — the pure helpers `parseModelString`, `genApiKey` and
  `generateUUID` (5 cases).
- `test/nova_canvas.test.ts` — the `selectChoiceOutputs` helper extracted from
  `nova_canvas.ts`, verifying it returns `undefined` (instead of throwing) when
  `choices.find` matches nothing, and unchanged values when a choice matches
  (3 cases).
- `test/key_email_regex.test.ts` — the email-key regex in `key.ts`, asserting
  the simplified character class matches the same inputs as the original
  (8 cases).
- `test/postgres_delete_multi.test.ts` — `deleteMulti`'s `where` guard, asserting
  it throws (and never calls `query`) on missing/empty `where` and passes the
  built SQL and params through otherwise (4 cases).
- `test/thread_list_key_id.test.ts` — `/user/thread/list` injecting `key_id`,
  asserting a forged `key_id` is overridden by `ctx.user.id` and the existing
  `/user/thread/detail` authorization behaviour is unchanged (3 cases).
- `test/prepare-dist-package.test.ts` — `makeRuntimePackage`, asserting the
  runtime `package.json` drops `devDependencies`/`scripts`/`pnpm` and keeps
  `dependencies`/`version`/whitelisted fields (6 cases).

External dependencies (config, model service, `nodemailer`,
`@aws-sdk/client-s3`, logger) are isolated with `vi.mock`, so the tests run
without a database or AWS/SMTP credentials.

### Lint

Lint is a **ratchet**: one flat config (`eslint.config.js`) covers both the
backend (`src/**/*.ts`) and the frontend (`src-frontend/**/*.{js,vue}`, Vue 3
via `eslint-plugin-vue`'s `flat/recommended` preset with its bundled
`vue-eslint-parser`), but three scripts split it into a blocking line and a
cleanup baseline. No rule is loosened and nothing is added to `ignores` — the
split is done purely with `--ignore-pattern` on the `lint` script, so
`git diff eslint.config.js` is empty.

- **`pnpm lint` — blocking line (must exit 0).** Runs
  `eslint . --ignore-pattern 'src-frontend/**'`, i.e. everything that has
  already been driven to zero: backend `src/**/*.ts`, `scripts/`, and the root
  config files (`babel.config.js`, `eslint.config.js`, `vite.config.js`).
  Current numbers: **0 errors, 0 warnings**. This is the line CI gates on
  (`.github/workflows/build.yml` runs `pnpm lint`) — a regression here is a bug
  and must not land.
- **`pnpm lint:ui` — cleanup baseline (allowed to exit non-zero).** Runs
  `eslint src-frontend`. Current numbers: **26 errors, 355 warnings**, exit 1.
  This is the *first recorded frontend baseline*, not a passing state; the
  frontend was newly brought under lint and its existing issues are **not**
  fixed here (that is a separate effort, cleaned in batches). These numbers
  must stay reproducible — if they change, a rule or `ignores` was touched.
- **`pnpm lint:all` — informational (non-blocking).** Runs `eslint .` over the
  whole repo; exits 1 until the frontend baseline is cleared. Use it locally to
  see everything at once.

Rationale for `--ignore-pattern` over editing the config's `ignores`: `lint:ui`
(`eslint src-frontend`) reads the same flat config, so putting the frontend
into a global `ignores` would silence it there too and the 26/355 baseline
would vanish — violating the "must stay reproducible" rule. `--ignore-pattern`
scopes the exclusion to the `lint` script alone.

The frontend errors and warnings are dominated by a handful of rules. Top rules
by combined (error + warning) count:

| count | rule |
|------:|------|
| 176 | `vue/max-attributes-per-line` |
|  74 | `vue/attributes-order` |
|  61 | `vue/singleline-html-element-content-newline` |
|  19 | `no-unused-vars` |
|  13 | `vue/attribute-hyphenation` |
|  10 | `vue/html-self-closing` |
|   6 | `vue/multi-word-component-names` |
|   6 | `vue/component-definition-name-casing` |
|   5 | `vue/v-on-event-hyphenation` |
|   4 | `vue/require-default-prop` |
|   3 | `vue/prop-name-casing` |
|   2 | `vue/html-indent` |
|   1 | `vue/no-template-shadow` |
|   1 | `vue/no-unused-vars` |

The 26 **errors** specifically are all real rule violations (no parsing/fatal
errors): `no-unused-vars` (19), `vue/multi-word-component-names` (6), and
`vue/no-unused-vars` (1).

### Build

`pnpm build` runs `build-server` (`tsc` → `dist/server/`) followed by
`build-ui` (`vite build` → `dist/frontend/`). Both must succeed for the build
to pass.

## Usage with Claude Code

```bash
export ANTHROPIC_BASE_URL=https://your-endpoint
export ANTHROPIC_API_KEY=your-api-key
export ANTHROPIC_MODEL=your-model
```

## Main Features

### Supported Models and Platforms

- Supports all current and future large language models from Bedrock (supported through bedrock-converse).
- Supports models deployed through Sagemaker LMI (partial models).
- Supports other forms of custom models, including Ollama, etc.
- More AI workflow applications, such as internet search, AWS command executors, etc.

### API Key and Cost Management

- Create API keys. Keys can be created for regular users and administrators. Regular users can chat, while administrators can manage API keys and costs.
- Record the cost of each call and use it as a basis for cost control.
- Cost control. You can set monthly quotas and account balances for each API key. When the monthly quota or account balance is insufficient, it cannot be used.
- Calculate the overall cost.

> [!IMPORTANT]  
>
> The cost calculation of this project cannot be used as the basis for AWS billing. Please refer to the AWS bill for actual expenses. [Please refer to the official website for the Bedrock pricing](https://aws.amazon.com/bedrock/pricing).

### Model Management

Models and their parameters can be defined from the backend.

Once defined, models can be bound to groups or API Keys.

### Default seed models

On first install BRConnector seeds a default model list into `eiai_model`
(`src/scripts/patch-0.0.5.sql`). The Claude seeds were rebuilt because Bedrock
now marks the old Claude 3.x models as **Legacy** and rejects `converse` on them.

- **Global cross-region profiles.** Both Claude seeds use the `global.` prefix
  (`global.anthropic.claude-sonnet-4-6`, `global.anthropic.claude-opus-4-8`).
  `global.` routes across all regions, so **one seed list works everywhere** —
  we no longer ship per-region lists. (The old `us.` prefix is US-only; switching
  an `us.`-seeded install to `eu.`/`apac.` regions leaves half the list unusable.)

- **Seeds are only a starting point.** Whether a model actually answers depends
  on **your account's Bedrock model access**, not on this seed list. A model can
  be `ACTIVE` in `list-inference-profiles` yet still be rejected at call time
  (e.g. Legacy models, or on-demand-unsupported models that require an inference
  profile). Always verify against your own account. Self-check commands:

  ```bash
  # Which cross-region inference profiles are ACTIVE in your region
  aws bedrock list-inference-profiles --region <your-region>
  # Which foundation models your account can see
  aws bedrock list-foundation-models --region <your-region>
  # Confirm a model actually answers (ACTIVE != callable):
  aws bedrock-runtime converse --region <your-region> \
    --model-id global.anthropic.claude-sonnet-4-6 \
    --messages '[{"role":"user","content":[{"text":"ping"}]}]'
  ```

- **Verifying a model through BRConnector.** After changing a model's `modelId`
  in the admin UI, the app caches the model list and refreshes it about once a
  minute (log line `The cache has been flushed`). So the loop is: change the
  `modelId` → wait ~60s for the cache flush → `POST /v1/chat/completions` once.
  Calling before the flush shows the old list in `/v1/models` and looks like the
  change didn't take.

- **Newly created models need a group binding.** A model with no group binding
  returns `You do not have permission to access the [xxx] model`. The seed
  migrations bind the default Claude seeds to `group 1` automatically.

> [!IMPORTANT]
> **Upgrading an existing database:** the seed rebuild ships as a guarded
> migration (`src/scripts/patch-0.0.42.sql`) that runs once on existing
> installs — it deletes the 10 legacy Claude 3.x seed rows and inserts the 2
> current Claude seeds. It only removes rows that still carry their original
> legacy `modelId` (rows you re-pointed to a working model, and any models you
> added yourself, are left untouched). **Back up your database before
> upgrading** so a legacy row can be restored if needed.

## Changelogs

## 0.0.41

1. **Anthropic Messages API Compatibility** - Added a new endpoint `POST /v1/messages` that is fully compatible with the Anthropic Messages API. Clients using the Anthropic SDK can now connect directly without modification. Supports text, tool use, thinking content blocks, and both streaming and non-streaming modes.

2. **x-api-key Header Support** - Added support for the `x-api-key` header (Anthropic SDK default) in addition to the existing `Authorization: Bearer` header.

3. **Bug Fix: claude-opus-4 temperature/topP** - Removed deprecated `temperature` and `topP` parameters for `claude-opus-4` and later models.

4. **Build Fix** - Removed hardcoded local path alias for `kui-vue` in `vite.config.js`. Downgraded `vite` from experimental `rolldown-vite` to stable `^6.3.3`.

## 0.0.40

1. **AWS Bedrock Bearer Token Support** - Added support for AWS Bedrock API Key (Bearer Token) authentication in addition to traditional AKSK credentials.

2. **Multi-tool Call Fix** - Fixed an issue where multiple tool calls in a single response were not handled correctly in streaming mode.

## 0.0.38

1. **Bedrock App Profiles Support** - Added support for Bedrock application profiles. [#87](https://github.com/aws-samples/sample-connector-for-bedrock/issues/87)

2. **PostgreSQL Database Upgrade** - Upgraded standalone PostgreSQL database from version 16.3 to 16.10. [#89](https://github.com/aws-samples/sample-connector-for-bedrock/pull/89)

3. **Zero-Length Messages Fix** - Fixed an issue where Bedrock would fail when processing zero-length messages. [#90](https://github.com/aws-samples/sample-connector-for-bedrock/pull/90)

4. **Tool Use Enhancement** - Improved tool use functionality with bug fixes and stability improvements. [#91](https://github.com/aws-samples/sample-connector-for-bedrock/pull/91) [#92](https://github.com/aws-samples/sample-connector-for-bedrock/pull/92)

[More changelogs](https://aws-samples.github.io/sample-connector-for-bedrock/home/changelogs/)

## Disclaimer

This connector is an open-source software aimed at providing proxy services for using Bedrock services. We make our best efforts to ensure the security and legality of the software, but we are not responsible for the users' behavior.

The connector is intended solely for personal learning and research purposes. Users shall not use it for any illegal activities, including but not limited to hacking, spreading illegal information, etc. Otherwise, users shall bear the corresponding legal responsibilities themselves. Users are responsible for complying with the laws and regulations in their respective jurisdictions and shall not use the connector for any illegal or non-compliant purposes. The developers and maintainers of this software shall not be liable for any disputes, losses, or legal liabilities arising from the use of this connector.

We reserve the right to modify or terminate the connector's code at any time without further notice. Users are expected to understand and comply with the relevant local laws and regulations.

If you have any questions regarding this disclaimer, please feel free to contact us through the open-source channels.

## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.

## License

This library is licensed under the MIT-0 License. See the LICENSE file.
