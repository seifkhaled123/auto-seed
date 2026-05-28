-- ============================================================
-- SaaS Platform (Linear / Notion-like) — PostgreSQL
-- Covers: partitioned table, materialized view, audit trigger,
-- API key hashing, UNIQUE NULLS NOT DISTINCT, polymorphic log,
-- optimistic locking, multi-tenant, JSONB settings.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Enum types ────────────────────────────────────────────────
CREATE TYPE plan_interval AS ENUM ('monthly', 'annual');

CREATE TYPE subscription_status AS ENUM (
  'trialing', 'active', 'past_due', 'unpaid', 'cancelled', 'paused', 'incomplete'
);

CREATE TYPE member_role AS ENUM ('owner', 'admin', 'member', 'viewer', 'guest');

CREATE TYPE invitation_status AS ENUM ('pending', 'accepted', 'expired', 'revoked');

CREATE TYPE invoice_status AS ENUM (
  'draft', 'open', 'paid', 'void', 'uncollectible'
);

CREATE TYPE webhook_event_type AS ENUM (
  'subscription.created', 'subscription.updated', 'subscription.cancelled',
  'invoice.paid', 'invoice.payment_failed',
  'member.added', 'member.removed',
  'organization.updated'
);

CREATE TYPE notification_channel AS ENUM ('in_app', 'email', 'slack', 'webhook');

-- ── Organizations ─────────────────────────────────────────────
CREATE TABLE organizations (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name         VARCHAR(300) NOT NULL,
  slug         VARCHAR(100) NOT NULL UNIQUE,
  logo_url     TEXT,
  website_url  TEXT,
  metadata     JSONB       NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE organization_settings (
  organization_id UUID        PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  settings        JSONB       NOT NULL DEFAULT '{}',
  features        JSONB       NOT NULL DEFAULT '{}',
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Users ─────────────────────────────────────────────────────
CREATE TABLE users (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email           VARCHAR(320) NOT NULL,
  email_verified  BOOLEAN     NOT NULL DEFAULT FALSE,
  name            VARCHAR(255),
  avatar_url      TEXT,
  password_hash   TEXT,
  totp_secret     TEXT,   -- encrypted; never store plaintext
  last_sign_in_at TIMESTAMPTZ,
  deleted_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_users_email_active ON users (LOWER(email)) WHERE deleted_at IS NULL;

CREATE TABLE user_profiles (
  user_id     UUID        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  bio         TEXT,
  timezone    VARCHAR(100) NOT NULL DEFAULT 'UTC',
  locale      VARCHAR(10)  NOT NULL DEFAULT 'en',
  preferences JSONB        NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── Memberships ───────────────────────────────────────────────
CREATE TABLE memberships (
  id              BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            member_role NOT NULL DEFAULT 'member',
  version         INTEGER     NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, user_id)
);

CREATE TABLE invitations (
  id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID            NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  invited_by_id   UUID            NOT NULL REFERENCES users(id),
  email           VARCHAR(320)    NOT NULL,
  role            member_role     NOT NULL DEFAULT 'member',
  status          invitation_status NOT NULL DEFAULT 'pending',
  token_hash      TEXT            NOT NULL UNIQUE,
  expires_at      TIMESTAMPTZ     NOT NULL,
  accepted_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- ── Plans & Subscriptions ─────────────────────────────────────
CREATE TABLE plans (
  id            VARCHAR(100) PRIMARY KEY,
  name          VARCHAR(200) NOT NULL,
  interval      plan_interval NOT NULL,
  price_cents   INTEGER      NOT NULL CHECK (price_cents >= 0),
  currency      CHAR(3)      NOT NULL DEFAULT 'USD',
  features      JSONB        NOT NULL DEFAULT '{}',
  is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
  sort_order    INTEGER      NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE plan_features (
  plan_id    VARCHAR(100) NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  feature    VARCHAR(100) NOT NULL,
  value      JSONB        NOT NULL DEFAULT 'true',
  PRIMARY KEY (plan_id, feature)
);

CREATE TABLE subscriptions (
  id                  UUID               PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID               NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plan_id             VARCHAR(100)       NOT NULL REFERENCES plans(id),
  status              subscription_status NOT NULL DEFAULT 'trialing',
  trial_ends_at       TIMESTAMPTZ,
  current_period_start TIMESTAMPTZ       NOT NULL,
  current_period_end   TIMESTAMPTZ       NOT NULL,
  cancel_at_period_end BOOLEAN           NOT NULL DEFAULT FALSE,
  cancelled_at        TIMESTAMPTZ,
  gateway             VARCHAR(100)       NOT NULL DEFAULT 'stripe',
  gateway_customer_id TEXT,
  gateway_subscription_id TEXT           UNIQUE,
  metadata            JSONB              NOT NULL DEFAULT '{}',
  version             INTEGER            NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ        NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ        NOT NULL DEFAULT NOW()
);

CREATE TABLE subscription_items (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID        NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  plan_id         VARCHAR(100) NOT NULL REFERENCES plans(id),
  quantity        INTEGER     NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price_cents INTEGER    NOT NULL,
  gateway_item_id TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Invoices ─────────────────────────────────────────────────
CREATE TABLE invoices (
  id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID            NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  subscription_id UUID            REFERENCES subscriptions(id) ON DELETE SET NULL,
  number          VARCHAR(64)     NOT NULL,
  status          invoice_status  NOT NULL DEFAULT 'draft',
  amount_due      INTEGER         NOT NULL,
  amount_paid     INTEGER         NOT NULL DEFAULT 0,
  currency        CHAR(3)         NOT NULL DEFAULT 'USD',
  due_date        DATE,
  period_start    DATE,
  period_end      DATE,
  gateway_invoice_id TEXT         UNIQUE,
  pdf_url         TEXT,
  metadata        JSONB           NOT NULL DEFAULT '{}',
  paid_at         TIMESTAMPTZ,
  voided_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, number)
);

CREATE TABLE invoice_items (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id  UUID        NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description VARCHAR(500) NOT NULL,
  quantity    INTEGER     NOT NULL DEFAULT 1,
  unit_amount INTEGER     NOT NULL,
  amount      INTEGER     NOT NULL,
  currency    CHAR(3)     NOT NULL,
  period_start DATE,
  period_end   DATE
);

-- ── Payment methods ───────────────────────────────────────────
CREATE TABLE payment_methods (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type                VARCHAR(50) NOT NULL,  -- 'card', 'bank_account', etc.
  is_default          BOOLEAN     NOT NULL DEFAULT FALSE,
  gateway             VARCHAR(100) NOT NULL DEFAULT 'stripe',
  gateway_pm_id       TEXT        NOT NULL,
  last_four           CHAR(4),
  brand               VARCHAR(50),
  exp_month           SMALLINT,
  exp_year            SMALLINT,
  billing_name        VARCHAR(255),
  billing_email       VARCHAR(320),
  metadata            JSONB       NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── API Keys ─────────────────────────────────────────────────
CREATE TABLE api_keys (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by_id   UUID        NOT NULL REFERENCES users(id),
  name            VARCHAR(255) NOT NULL,
  key_prefix      CHAR(8)     NOT NULL,       -- first 8 chars shown in UI
  key_hash        TEXT        NOT NULL UNIQUE, -- bcrypt/sha256 of full key; never store plaintext
  scopes          TEXT[]      NOT NULL DEFAULT '{}',
  last_used_at    TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_api_keys_active ON api_keys (organization_id)
  WHERE revoked_at IS NULL;

-- ── Webhooks ─────────────────────────────────────────────────
CREATE TABLE webhooks (
  id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID            NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  url             TEXT            NOT NULL,
  secret_hash     TEXT            NOT NULL,  -- HMAC secret; stored hashed
  event_types     webhook_event_type[] NOT NULL DEFAULT '{}',
  is_active       BOOLEAN         NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE TABLE webhook_deliveries (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id      UUID        NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event_type      webhook_event_type NOT NULL,
  payload         JSONB       NOT NULL,
  response_status INTEGER,
  response_body   TEXT,
  attempt         SMALLINT    NOT NULL DEFAULT 1,
  next_retry_at   TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Feature flags ─────────────────────────────────────────────
CREATE TABLE feature_flags (
  id              BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id UUID        REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         UUID        REFERENCES users(id) ON DELETE CASCADE,
  flag            VARCHAR(100) NOT NULL,
  enabled         BOOLEAN     NOT NULL DEFAULT FALSE,
  payload         JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Either org-level, user-level, or global
  UNIQUE NULLS NOT DISTINCT (organization_id, user_id, flag)
);

-- ── Audit log (polymorphic) ───────────────────────────────────
CREATE TABLE audit_logs (
  id              BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id UUID        REFERENCES organizations(id) ON DELETE SET NULL,
  actor_id        UUID        REFERENCES users(id) ON DELETE SET NULL,
  actor_type      VARCHAR(50) NOT NULL DEFAULT 'user',
  action          VARCHAR(100) NOT NULL,
  resource_type   VARCHAR(100) NOT NULL,
  resource_id     TEXT        NOT NULL,
  before_data     JSONB,
  after_data      JSONB,
  diff            JSONB,
  ip_address      INET,
  user_agent      TEXT,
  request_id      UUID,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_logs_resource ON audit_logs (resource_type, resource_id);
CREATE INDEX idx_audit_logs_actor ON audit_logs (actor_id, occurred_at DESC);
CREATE INDEX idx_audit_logs_org ON audit_logs (organization_id, occurred_at DESC);

-- ── Usage records ─────────────────────────────────────────────
CREATE TABLE usage_records (
  id              BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  subscription_id UUID        REFERENCES subscriptions(id) ON DELETE SET NULL,
  metric          VARCHAR(100) NOT NULL,
  quantity        NUMERIC(20,4) NOT NULL,
  recorded_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── Events (partitioned by month for scalability) ─────────────
CREATE TABLE events (
  id              UUID        NOT NULL DEFAULT gen_random_uuid(),
  organization_id UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         UUID        REFERENCES users(id) ON DELETE SET NULL,
  event_name      VARCHAR(200) NOT NULL,
  properties      JSONB       NOT NULL DEFAULT '{}',
  session_id      UUID,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

-- Monthly partitions (example — production would auto-create these)
CREATE TABLE events_2024_01 PARTITION OF events
  FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');

CREATE TABLE events_2024_02 PARTITION OF events
  FOR VALUES FROM ('2024-02-01') TO ('2024-03-01');

CREATE TABLE events_default PARTITION OF events DEFAULT;

-- ── Notifications ────────────────────────────────────────────
CREATE TABLE notifications (
  id              UUID                 PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID                 REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         UUID                 NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel         notification_channel NOT NULL DEFAULT 'in_app',
  title           VARCHAR(500)         NOT NULL,
  body            TEXT,
  action_url      TEXT,
  metadata        JSONB                NOT NULL DEFAULT '{}',
  read_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ          NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notifications_unread ON notifications (user_id, created_at DESC)
  WHERE read_at IS NULL;

-- ── Materialized view: monthly usage summary ─────────────────
CREATE MATERIALIZED VIEW monthly_usage_summary AS
  SELECT
    organization_id,
    metric,
    DATE_TRUNC('month', recorded_at) AS month,
    SUM(quantity)                     AS total_quantity,
    COUNT(*)                          AS record_count
  FROM usage_records
  GROUP BY organization_id, metric, DATE_TRUNC('month', recorded_at)
WITH DATA;

CREATE UNIQUE INDEX idx_monthly_usage_summary
  ON monthly_usage_summary (organization_id, metric, month);

-- ── Audit trigger ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION audit_log_changes()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO audit_logs (action, resource_type, resource_id, before_data, after_data)
  VALUES (
    TG_OP,
    TG_TABLE_NAME,
    COALESCE(NEW.id::TEXT, OLD.id::TEXT),
    CASE WHEN TG_OP != 'INSERT' THEN to_jsonb(OLD) END,
    CASE WHEN TG_OP != 'DELETE' THEN to_jsonb(NEW) END
  );
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER trg_subscriptions_audit
  AFTER INSERT OR UPDATE OR DELETE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION audit_log_changes();

-- ── Indexes ───────────────────────────────────────────────────
CREATE INDEX idx_events_org_name ON events (organization_id, event_name, occurred_at DESC);
CREATE INDEX idx_events_properties ON events USING GIN (properties);
CREATE INDEX idx_feature_flags_lookup ON feature_flags (flag, organization_id);
