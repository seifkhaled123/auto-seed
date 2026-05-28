-- ============================================================
-- E-Commerce Platform (Shopify-like) — PostgreSQL
-- Covers: CREATE TYPE, CREATE DOMAIN, UUID PKs, JSONB, closure
-- table, tsvector, GENERATED ALWAYS AS IDENTITY, GIN index,
-- partial index, expression index, trigger, view.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Enum types ────────────────────────────────────────────────
CREATE TYPE order_status AS ENUM (
  'pending','confirmed','processing','shipped','delivered','cancelled','refunded'
);

CREATE TYPE payment_status AS ENUM (
  'pending','authorized','captured','failed','refunded','partially_refunded'
);

CREATE TYPE discount_type AS ENUM (
  'percentage','fixed_amount','free_shipping','buy_x_get_y'
);

CREATE TYPE fulfillment_status AS ENUM (
  'unfulfilled','partial','fulfilled','restocked'
);

-- ── Domains ───────────────────────────────────────────────────
CREATE DOMAIN positive_amount AS NUMERIC(19,4) CHECK (VALUE >= 0);
CREATE DOMAIN email_address   AS VARCHAR(320)  CHECK (VALUE ~* '^[^@]+@[^@]+\.[^@]+$');
CREATE DOMAIN slug_text       AS VARCHAR(255)  CHECK (VALUE ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$');

-- ── Tenants (multi-store) ─────────────────────────────────────
CREATE TABLE tenants (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(200) NOT NULL,
  slug        slug_text   NOT NULL UNIQUE,
  settings    JSONB       NOT NULL DEFAULT '{}',
  locale      VARCHAR(10) NOT NULL DEFAULT 'en',
  currency    CHAR(3)     NOT NULL DEFAULT 'USD',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Customers ─────────────────────────────────────────────────
CREATE TABLE customers (
  id                BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id         UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email             email_address NOT NULL,
  first_name        VARCHAR(120),
  last_name         VARCHAR(120),
  phone             VARCHAR(30),
  accepts_marketing BOOLEAN     NOT NULL DEFAULT FALSE,
  tags              TEXT[]      NOT NULL DEFAULT '{}',
  metadata          JSONB       NOT NULL DEFAULT '{}',
  note              TEXT,
  verified_email    BOOLEAN     NOT NULL DEFAULT FALSE,
  last_order_id     BIGINT,  -- back-filled FK to orders, nullable
  orders_count      INTEGER     NOT NULL DEFAULT 0,
  total_spent       positive_amount NOT NULL DEFAULT 0,
  deleted_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE NULLS NOT DISTINCT (tenant_id, email, deleted_at)
);

-- ── Addresses ────────────────────────────────────────────────
CREATE TABLE addresses (
  id            BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id   BIGINT      REFERENCES customers(id) ON DELETE SET NULL,
  first_name    VARCHAR(120),
  last_name     VARCHAR(120),
  company       VARCHAR(200),
  address1      VARCHAR(500) NOT NULL,
  address2      VARCHAR(500),
  city          VARCHAR(200) NOT NULL,
  province      VARCHAR(200),
  province_code CHAR(10),
  country       VARCHAR(200) NOT NULL,
  country_code  CHAR(2)      NOT NULL,
  zip           VARCHAR(20),
  phone         VARCHAR(30),
  is_default    BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── Categories (adjacency list + closure table) ───────────────
CREATE TABLE categories (
  id           BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  parent_id    BIGINT      REFERENCES categories(id) ON DELETE SET NULL,
  name         VARCHAR(255) NOT NULL,
  slug         slug_text   NOT NULL,
  description  TEXT,
  image_url    TEXT,
  position     INTEGER     NOT NULL DEFAULT 0,
  is_active    BOOLEAN     NOT NULL DEFAULT TRUE,
  metadata     JSONB       NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, slug)
);

CREATE TABLE category_closures (
  ancestor_id   BIGINT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  descendant_id BIGINT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  depth         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ancestor_id, descendant_id)
);

-- ── Products ─────────────────────────────────────────────────
CREATE TABLE products (
  id             BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id      UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  category_id    BIGINT      REFERENCES categories(id) ON DELETE SET NULL,
  title          VARCHAR(500) NOT NULL,
  handle         slug_text   NOT NULL,
  body_html      TEXT,
  vendor         VARCHAR(255),
  product_type   VARCHAR(255),
  tags           TEXT[]      NOT NULL DEFAULT '{}',
  options        JSONB       NOT NULL DEFAULT '[]',
  metadata       JSONB       NOT NULL DEFAULT '{}',
  published_at   TIMESTAMPTZ,
  deleted_at     TIMESTAMPTZ,
  search_vector  tsvector    GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(title,'') || ' ' || coalesce(vendor,'') || ' ' || coalesce(product_type,''))
  ) STORED,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, handle)
);

CREATE TABLE product_options (
  id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id BIGINT      NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name       VARCHAR(255) NOT NULL,
  position   INTEGER     NOT NULL DEFAULT 0
);

CREATE TABLE product_option_values (
  id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  option_id  BIGINT      NOT NULL REFERENCES product_options(id) ON DELETE CASCADE,
  value      VARCHAR(255) NOT NULL,
  position   INTEGER     NOT NULL DEFAULT 0,
  UNIQUE (option_id, value)
);

CREATE TABLE product_variants (
  id                 BIGINT          GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id         BIGINT          NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku                VARCHAR(255),
  barcode            VARCHAR(255),
  title              VARCHAR(500)    NOT NULL DEFAULT 'Default Title',
  price              positive_amount NOT NULL,
  compare_at_price   positive_amount,
  cost_per_item      positive_amount,
  option_values      JSONB           NOT NULL DEFAULT '{}',
  weight             NUMERIC(10,3),
  weight_unit        VARCHAR(10)     NOT NULL DEFAULT 'kg',
  requires_shipping  BOOLEAN         NOT NULL DEFAULT TRUE,
  taxable            BOOLEAN         NOT NULL DEFAULT TRUE,
  fulfillment_service VARCHAR(100),
  inventory_management VARCHAR(100),
  position           INTEGER         NOT NULL DEFAULT 0,
  metadata           JSONB           NOT NULL DEFAULT '{}',
  created_at         TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  UNIQUE (product_id, sku)
);

CREATE TABLE product_images (
  id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id  BIGINT      NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id  BIGINT      REFERENCES product_variants(id) ON DELETE SET NULL,
  src         TEXT        NOT NULL,
  alt         VARCHAR(512),
  width       INTEGER,
  height      INTEGER,
  position    INTEGER     NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Inventory ────────────────────────────────────────────────
CREATE TABLE inventory_locations (
  id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id  UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       VARCHAR(255) NOT NULL,
  address1   VARCHAR(500),
  city       VARCHAR(200),
  country_code CHAR(2),
  is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE inventory_items (
  id           BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  variant_id   BIGINT      NOT NULL UNIQUE REFERENCES product_variants(id) ON DELETE CASCADE,
  sku          VARCHAR(255),
  tracked      BOOLEAN     NOT NULL DEFAULT TRUE,
  cost         positive_amount,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE inventory_levels (
  inventory_item_id BIGINT  NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  location_id       BIGINT  NOT NULL REFERENCES inventory_locations(id) ON DELETE CASCADE,
  available         INTEGER NOT NULL DEFAULT 0,
  incoming          INTEGER NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (inventory_item_id, location_id)
);

-- ── Discount codes ───────────────────────────────────────────
CREATE TABLE discount_codes (
  id               BIGINT          GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id        UUID            NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code             VARCHAR(255)    NOT NULL,
  discount_type    discount_type   NOT NULL,
  value            NUMERIC(10,4)   NOT NULL,
  minimum_amount   positive_amount,
  minimum_quantity INTEGER,
  usage_limit      INTEGER,
  usage_count      INTEGER         NOT NULL DEFAULT 0,
  applies_to_all   BOOLEAN         NOT NULL DEFAULT TRUE,
  starts_at        TIMESTAMPTZ,
  ends_at          TIMESTAMPTZ,
  is_active        BOOLEAN         NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, code)
);

-- ── Gift cards ───────────────────────────────────────────────
CREATE TABLE gift_cards (
  id              BIGINT          GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id       UUID            NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code            VARCHAR(64)     NOT NULL,
  initial_value   positive_amount NOT NULL,
  balance         positive_amount NOT NULL,
  currency        CHAR(3)         NOT NULL,
  customer_id     BIGINT          REFERENCES customers(id) ON DELETE SET NULL,
  expires_on      DATE,
  is_disabled     BOOLEAN         NOT NULL DEFAULT FALSE,
  note            TEXT,
  created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- Active gift cards must have unique codes per tenant
CREATE UNIQUE INDEX idx_gift_cards_active_code
  ON gift_cards (tenant_id, code)
  WHERE is_disabled = FALSE;

CREATE TABLE gift_card_usages (
  id           BIGINT          GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  gift_card_id BIGINT          NOT NULL REFERENCES gift_cards(id) ON DELETE CASCADE,
  amount       positive_amount NOT NULL,
  note         TEXT,
  created_at   TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- ── Orders ───────────────────────────────────────────────────
CREATE TABLE orders (
  id                BIGINT          GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id         UUID            NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id       BIGINT          REFERENCES customers(id) ON DELETE SET NULL,
  email             email_address,
  order_number      INTEGER         NOT NULL,
  status            order_status    NOT NULL DEFAULT 'pending',
  fulfillment_status fulfillment_status NOT NULL DEFAULT 'unfulfilled',
  financial_status  payment_status  NOT NULL DEFAULT 'pending',
  currency          CHAR(3)         NOT NULL,
  subtotal_price    positive_amount NOT NULL,
  total_discounts   positive_amount NOT NULL DEFAULT 0,
  total_tax         positive_amount NOT NULL DEFAULT 0,
  total_price       positive_amount NOT NULL,
  shipping_address_id BIGINT        REFERENCES addresses(id) ON DELETE SET NULL,
  billing_address_id  BIGINT        REFERENCES addresses(id) ON DELETE SET NULL,
  note              TEXT,
  tags              TEXT[]          NOT NULL DEFAULT '{}',
  metadata          JSONB           NOT NULL DEFAULT '{}',
  cancelled_at      TIMESTAMPTZ,
  cancel_reason     VARCHAR(255),
  closed_at         TIMESTAMPTZ,
  processed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, order_number)
);

CREATE TABLE order_line_items (
  id              BIGINT          GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id        BIGINT          NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  variant_id      BIGINT          REFERENCES product_variants(id) ON DELETE SET NULL,
  product_id      BIGINT          REFERENCES products(id) ON DELETE SET NULL,
  title           VARCHAR(500)    NOT NULL,
  variant_title   VARCHAR(255),
  sku             VARCHAR(255),
  quantity        INTEGER         NOT NULL CHECK (quantity > 0),
  price           positive_amount NOT NULL,
  total_discount  positive_amount NOT NULL DEFAULT 0,
  taxable         BOOLEAN         NOT NULL DEFAULT TRUE,
  gift_card       BOOLEAN         NOT NULL DEFAULT FALSE,
  fulfillable_quantity INTEGER     NOT NULL DEFAULT 0,
  fulfillment_status VARCHAR(50),
  properties      JSONB           NOT NULL DEFAULT '[]',
  tax_lines       JSONB           NOT NULL DEFAULT '[]'
);

CREATE TABLE order_shipping_lines (
  id              BIGINT          GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id        BIGINT          NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  title           VARCHAR(255)    NOT NULL,
  carrier_identifier VARCHAR(255),
  code            VARCHAR(255),
  price           positive_amount NOT NULL,
  discounted_price positive_amount NOT NULL,
  tax_lines       JSONB           NOT NULL DEFAULT '[]'
);

CREATE TABLE order_discount_codes (
  id            BIGINT          GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id      BIGINT          NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  code          VARCHAR(255)    NOT NULL,
  discount_type discount_type   NOT NULL,
  amount        positive_amount NOT NULL
);

-- ── Payments & Refunds ────────────────────────────────────────
CREATE TABLE payments (
  id                  BIGINT          GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id            BIGINT          NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  gateway             VARCHAR(100)    NOT NULL,
  status              payment_status  NOT NULL,
  amount              positive_amount NOT NULL,
  currency            CHAR(3)         NOT NULL,
  gateway_transaction_id VARCHAR(255),
  gateway_response    JSONB           NOT NULL DEFAULT '{}',
  error_code          VARCHAR(100),
  error_message       TEXT,
  processed_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE TABLE refunds (
  id           BIGINT          GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id     BIGINT          NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  note         TEXT,
  restock      BOOLEAN         NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE TABLE refund_line_items (
  id              BIGINT          GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  refund_id       BIGINT          NOT NULL REFERENCES refunds(id) ON DELETE CASCADE,
  line_item_id    BIGINT          NOT NULL REFERENCES order_line_items(id),
  quantity        INTEGER         NOT NULL CHECK (quantity > 0),
  restock_type    VARCHAR(50),
  subtotal        positive_amount NOT NULL,
  total_tax       positive_amount NOT NULL DEFAULT 0
);

-- ── Reviews ───────────────────────────────────────────────────
CREATE TABLE reviews (
  id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id  BIGINT      NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  customer_id BIGINT      REFERENCES customers(id) ON DELETE SET NULL,
  order_id    BIGINT      REFERENCES orders(id) ON DELETE SET NULL,
  rating      SMALLINT    NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title       VARCHAR(255),
  body        TEXT,
  is_verified BOOLEAN     NOT NULL DEFAULT FALSE,
  published_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Wishlists ─────────────────────────────────────────────────
CREATE TABLE wishlists (
  id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id BIGINT      NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  name        VARCHAR(255) NOT NULL DEFAULT 'My Wishlist',
  is_public   BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE wishlist_items (
  wishlist_id BIGINT      NOT NULL REFERENCES wishlists(id) ON DELETE CASCADE,
  variant_id  BIGINT      NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (wishlist_id, variant_id)
);

-- ── Indexes ───────────────────────────────────────────────────
CREATE INDEX idx_products_search ON products USING GIN (search_vector);
CREATE INDEX idx_products_tags ON products USING GIN (tags);
CREATE INDEX idx_customers_tags ON customers USING GIN (tags);
CREATE INDEX idx_customers_metadata ON customers USING GIN (metadata);
CREATE INDEX idx_orders_customer ON orders (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX idx_orders_status ON orders (tenant_id, status, created_at DESC);
CREATE INDEX idx_orders_search_email ON orders (LOWER(email::TEXT));
CREATE INDEX idx_products_active ON products (tenant_id, category_id)
  WHERE deleted_at IS NULL AND published_at IS NOT NULL;

-- ── Auto-update updated_at trigger ───────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_tenants_updated_at    BEFORE UPDATE ON tenants    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_customers_updated_at  BEFORE UPDATE ON customers  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_products_updated_at   BEFORE UPDATE ON products   FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_orders_updated_at     BEFORE UPDATE ON orders     FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_payments_updated_at   BEFORE UPDATE ON payments   FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Views ─────────────────────────────────────────────────────
CREATE VIEW active_inventory AS
  SELECT
    il.inventory_item_id,
    ii.variant_id,
    il.location_id,
    loc.name   AS location_name,
    il.available,
    il.incoming,
    pv.sku,
    pv.price,
    p.title    AS product_title,
    p.tenant_id
  FROM inventory_levels il
  JOIN inventory_items ii   ON ii.id = il.inventory_item_id
  JOIN inventory_locations loc ON loc.id = il.location_id
  JOIN product_variants pv  ON pv.id = ii.variant_id
  JOIN products p            ON p.id = pv.product_id
  WHERE loc.is_active = TRUE
    AND p.deleted_at IS NULL;

-- ON CONFLICT usage example (documented for seeding reference):
-- INSERT INTO customers (tenant_id, email, ...) VALUES (...)
-- ON CONFLICT (tenant_id, email, deleted_at) DO UPDATE SET updated_at = NOW();
