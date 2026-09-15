CREATE TABLE IF NOT EXISTS eiai_group (
    id serial PRIMARY KEY,
    name varchar(64) NOT NULL,
    key varchar(64),
    created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
);


CREATE TABLE IF NOT EXISTS eiai_group_model (
    id serial PRIMARY KEY,
    model_id int NOT NULL,
    group_id int NOT NULL,
    created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE eiai_model
ADD COLUMN multiple int DEFAULT 0,
ADD COLUMN model_type int DEFAULT 1,
ADD COLUMN price_in decimal(10, 10) NOT NULL DEFAULT 0.00,
ADD COLUMN price_out decimal(10, 10) NOT NULL DEFAULT 0.00,
ADD COLUMN provider VARCHAR(255);

ALTER TABLE eiai_model ADD CONSTRAINT model_name_uniqe UNIQUE (name);

ALTER TABLE eiai_group_model ADD CONSTRAINT model_group_id_uniqe UNIQUE (model_id, group_id);

-- Seed definition narrowed to two current Claude models (PIPE-104 / PIPE-107).
-- The 10 legacy Claude 3.x rows were already dropped (Bedrock marks them Legacy
-- and rejects converse). This revision also removes the 9 non-Claude seeds
-- (Nova x3 + Mistral x4 + Llama3 x2): the seed is only a starting point; other
-- models are added per-deployment in /admin. NOTE: this only trims the *seed
-- definition* for brand-new installs — it never DELETEs rows from an already
-- deployed database (that path is patch-0.0.42.sql, which leaves non-Claude
-- rows untouched). Both models use the global. cross-region inference profile
-- (one list works in every region; us. was US-only). Prices are current AWS
-- Bedrock / Anthropic standard (global-endpoint) rates as $X/1M = Xe-6:
--   Sonnet 4.6: $3/1M in, $15/1M out   Opus 4.8: $5/1M in, $25/1M out
INSERT INTO eiai_model (name, multiple, provider, config, price_in, price_out)
VALUES ('claude-sonnet-4-6', 1, 'bedrock-converse', '{"modelId": "global.anthropic.claude-sonnet-4-6"}', 3e-6, 15e-6 ) ON CONFLICT (name) DO NOTHING;
INSERT INTO eiai_model (name, multiple, provider, config, price_in, price_out)
VALUES ('claude-opus-4-8', 1, 'bedrock-converse', '{"modelId": "global.anthropic.claude-opus-4-8"}', 5e-6, 25e-6 ) ON CONFLICT (name) DO NOTHING;


INSERT INTO eiai_group (name) VALUES ('group 1');

INSERT INTO eiai_group_model (model_id, group_id) 
SELECT id, 1 FROM eiai_model ON CONFLICT (model_id, group_id) DO NOTHING;



CREATE OR REPLACE VIEW eiai_v_group_model AS
SELECT gm.*, g.name group_name, m.name model_name, m.multiple, m.price_in, m.price_out, m.provider, m.config from eiai_group_model gm 
LEFT JOIN eiai_group g ON gm.group_id=g.id
LEFT JOIN eiai_model m ON gm.model_id=m.id;


CREATE OR REPLACE VIEW eiai_v_key_model AS
SELECT km.*, k.name key_name, m.name model_name, m.multiple, m.price_in, m.price_out, m.provider, m.config from eiai_key_model km
LEFT JOIN eiai_key k ON km.key_id=k.id
LEFT JOIN eiai_model m ON km.model_id=m.id;

CREATE OR REPLACE VIEW eiai_v_key_group AS
SELECT k.*, g.name group_name from eiai_key k
LEFT JOIN eiai_group g ON k.group_id=g.id;


