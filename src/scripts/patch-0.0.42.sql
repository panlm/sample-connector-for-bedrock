-- patch-0.0.42.sql (PIPE-104): rebuild the Claude seed list on EXISTING databases.
--
-- Why a new patch: patch-0.0.5 only runs on fresh installs (its guard in
-- install.ts is "eiai_group does not exist"), and its INSERTs use
-- ON CONFLICT (name) DO NOTHING, so simply editing 0.0.5 never touches an
-- already-installed instance. This migration performs the one-time cleanup on
-- existing databases: drop the 10 legacy Claude 3.x seeds, insert the 2 current
-- Claude seeds, bind them to group 1, and drop a marker table so install.ts can
-- guard it. Wrapped in a single transaction so any failure rolls the whole thing
-- back (idempotent: re-running is a no-op because the marker table then exists).
--
-- Legacy deletion uses a DOUBLE condition: name IN (...legacy names...) AND the
-- config->>'modelId' still equals the ORIGINAL legacy modelId. This protects rows
-- a user has re-pointed to a working model (the reporter demonstrated repointing
-- id=12 to a usable model): such rows keep their old seed name but a new modelId,
-- so they are NOT deleted. Rows still carrying the original legacy modelId are
-- clearly untouched seeds and are safe to remove. (See PIPE-106 risk R2 — this
-- is the safe default; flip to name-only delete by dropping the AND clause if the
-- owner decides re-pointed rows should also go.)

BEGIN;

-- (a) Clear dangling group/key bindings for the legacy seed rows first
--     (eiai_group_model / eiai_key_model have no FK to eiai_model, so deleting
--     the model rows alone would leave orphan bindings).
DELETE FROM eiai_group_model WHERE model_id IN (
    SELECT id FROM eiai_model WHERE name IN (
        'claude-3-7-sonnet','cr-claude-3-7-sonnet','claude-3-5-sonnet-v2','claude-3-5-sonnet',
        'cr-claude-3-5-sonnet-v2','cr-claude-3-5-sonnet','claude-3-5-haiku','claude-3-sonnet',
        'claude-3-haiku','claude-3-opus'
    ) AND config->>'modelId' IN (
        'anthropic.claude-3-7-sonnet-20250219-v1:0','us.anthropic.claude-3-7-sonnet-20250219-v1:0',
        'anthropic.claude-3-5-sonnet-20241022-v2:0','anthropic.claude-3-5-sonnet-20240620-v1:0',
        'us.anthropic.claude-3-5-sonnet-20241022-v2:0','us.anthropic.claude-3-5-sonnet-20240620-v1:0',
        'anthropic.claude-3-5-haiku-20241022-v1:0','anthropic.claude-3-sonnet-20240229-v1:0',
        'anthropic.claude-3-haiku-20240307-v1:0','anthropic.claude-3-opus-20240229-v1:0'
    )
);

DELETE FROM eiai_key_model WHERE model_id IN (
    SELECT id FROM eiai_model WHERE name IN (
        'claude-3-7-sonnet','cr-claude-3-7-sonnet','claude-3-5-sonnet-v2','claude-3-5-sonnet',
        'cr-claude-3-5-sonnet-v2','cr-claude-3-5-sonnet','claude-3-5-haiku','claude-3-sonnet',
        'claude-3-haiku','claude-3-opus'
    ) AND config->>'modelId' IN (
        'anthropic.claude-3-7-sonnet-20250219-v1:0','us.anthropic.claude-3-7-sonnet-20250219-v1:0',
        'anthropic.claude-3-5-sonnet-20241022-v2:0','anthropic.claude-3-5-sonnet-20240620-v1:0',
        'us.anthropic.claude-3-5-sonnet-20241022-v2:0','us.anthropic.claude-3-5-sonnet-20240620-v1:0',
        'anthropic.claude-3-5-haiku-20241022-v1:0','anthropic.claude-3-sonnet-20240229-v1:0',
        'anthropic.claude-3-haiku-20240307-v1:0','anthropic.claude-3-opus-20240229-v1:0'
    )
);

-- (b) Delete the legacy Claude 3.x seed rows (double condition: name + original
--     legacy modelId). Re-pointed rows and user-added models are untouched.
DELETE FROM eiai_model WHERE name IN (
    'claude-3-7-sonnet','cr-claude-3-7-sonnet','claude-3-5-sonnet-v2','claude-3-5-sonnet',
    'cr-claude-3-5-sonnet-v2','cr-claude-3-5-sonnet','claude-3-5-haiku','claude-3-sonnet',
    'claude-3-haiku','claude-3-opus'
) AND config->>'modelId' IN (
    'anthropic.claude-3-7-sonnet-20250219-v1:0','us.anthropic.claude-3-7-sonnet-20250219-v1:0',
    'anthropic.claude-3-5-sonnet-20241022-v2:0','anthropic.claude-3-5-sonnet-20240620-v1:0',
    'us.anthropic.claude-3-5-sonnet-20241022-v2:0','us.anthropic.claude-3-5-sonnet-20240620-v1:0',
    'anthropic.claude-3-5-haiku-20241022-v1:0','anthropic.claude-3-sonnet-20240229-v1:0',
    'anthropic.claude-3-haiku-20240307-v1:0','anthropic.claude-3-opus-20240229-v1:0'
);

-- (c) Insert the 2 current Claude seeds. ON CONFLICT (name) DO NOTHING keeps this
--     idempotent and never overwrites a user's same-named row. Prices are current
--     AWS Bedrock / Anthropic standard (global-endpoint) rates ($X/1M = Xe-6):
--     Sonnet 4.6 $3/$15 per 1M; Opus 4.8 $5/$25 per 1M.
INSERT INTO eiai_model (name, multiple, provider, config, price_in, price_out)
VALUES ('claude-sonnet-4-6', 1, 'bedrock-converse', '{"modelId": "global.anthropic.claude-sonnet-4-6"}', 3e-6, 15e-6 ) ON CONFLICT (name) DO NOTHING;
INSERT INTO eiai_model (name, multiple, provider, config, price_in, price_out)
VALUES ('claude-opus-4-8', 1, 'bedrock-converse', '{"modelId": "global.anthropic.claude-opus-4-8"}', 5e-6, 25e-6 ) ON CONFLICT (name) DO NOTHING;

-- (d) Bind the 2 new Claude seeds to group 1 (same default group patch-0.0.5 uses).
--     ON CONFLICT keeps it idempotent and won't duplicate an existing binding.
INSERT INTO eiai_group_model (model_id, group_id)
SELECT id, 1 FROM eiai_model WHERE name IN ('claude-sonnet-4-6','claude-opus-4-8')
ON CONFLICT (model_id, group_id) DO NOTHING;

-- (e) Marker table = "this migration has been applied" guard for install.ts.
CREATE TABLE eiai_migration_0_0_42 (
    applied_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMIT;
