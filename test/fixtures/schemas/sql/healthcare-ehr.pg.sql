-- ============================================================
-- Healthcare EHR — PostgreSQL
-- Covers: CREATE DOMAIN, regex-checked domains, daterange,
-- NUMERIC vitals, audit trigger with full row snapshot,
-- self-ref providers, INHERITS table inheritance.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Domains (strongly-typed medical codes) ────────────────────
CREATE DOMAIN icd10_code  AS VARCHAR(10) CHECK (VALUE ~ '^[A-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$');
CREATE DOMAIN npi_number  AS CHAR(10)    CHECK (VALUE ~ '^[0-9]{10}$');
CREATE DOMAIN phone_number AS VARCHAR(20);
CREATE DOMAIN us_zip_code AS VARCHAR(10) CHECK (VALUE ~ '^[0-9]{5}(-[0-9]{4})?$');
CREATE DOMAIN iso_currency AS CHAR(3)    CHECK (VALUE ~ '^[A-Z]{3}$');

-- ── Enum types ────────────────────────────────────────────────
CREATE TYPE gender AS ENUM ('male', 'female', 'non_binary', 'other', 'prefer_not_to_say', 'unknown');

CREATE TYPE appointment_status AS ENUM (
  'scheduled', 'confirmed', 'checked_in', 'in_progress', 'completed',
  'no_show', 'cancelled', 'rescheduled'
);

CREATE TYPE encounter_type AS ENUM (
  'outpatient', 'inpatient', 'emergency', 'telemedicine', 'home_visit', 'preventive'
);

CREATE TYPE claim_status AS ENUM (
  'draft', 'submitted', 'pending', 'approved', 'partially_approved',
  'denied', 'appealed', 'paid', 'void'
);

CREATE TYPE lab_status AS ENUM (
  'ordered', 'collected', 'processing', 'resulted', 'cancelled', 'error'
);

CREATE TYPE prescription_status AS ENUM (
  'active', 'completed', 'discontinued', 'on_hold', 'expired'
);

-- ── Organizations (clinics, hospitals) ───────────────────────
CREATE TABLE organizations (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name         VARCHAR(500) NOT NULL,
  npi          npi_number  UNIQUE,
  type         VARCHAR(100) NOT NULL DEFAULT 'clinic',  -- 'clinic','hospital','lab','pharmacy'
  address1     VARCHAR(500),
  address2     VARCHAR(500),
  city         VARCHAR(200),
  state        CHAR(2),
  zip          us_zip_code,
  phone        phone_number,
  fax          phone_number,
  website      TEXT,
  tax_id       VARCHAR(20),
  settings     JSONB        NOT NULL DEFAULT '{}',
  is_active    BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── Specialties (lookup) ─────────────────────────────────────
CREATE TABLE specialties (
  id          SMALLINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        VARCHAR(50)  NOT NULL UNIQUE,
  name        VARCHAR(200) NOT NULL,
  description TEXT
);

-- ── Providers ────────────────────────────────────────────────
CREATE TABLE providers (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  supervisor_id   UUID        REFERENCES providers(id) ON DELETE SET NULL,  -- nullable self-ref
  npi             npi_number  NOT NULL UNIQUE,
  first_name      VARCHAR(120) NOT NULL,
  last_name       VARCHAR(120) NOT NULL,
  middle_name     VARCHAR(120),
  credentials     VARCHAR(100),  -- 'MD', 'DO', 'NP', 'PA', etc.
  email           VARCHAR(320) NOT NULL,
  phone           phone_number,
  gender          gender,
  license_number  VARCHAR(100),
  license_state   CHAR(2),
  license_expiry  DATE,
  bio             TEXT,
  accepting_patients BOOLEAN  NOT NULL DEFAULT TRUE,
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  deleted_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, email)
);

CREATE TABLE provider_specialties (
  provider_id  UUID     NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  specialty_id SMALLINT NOT NULL REFERENCES specialties(id),
  is_primary   BOOLEAN  NOT NULL DEFAULT FALSE,
  PRIMARY KEY (provider_id, specialty_id)
);

-- ── Patients ──────────────────────────────────────────────────
CREATE TABLE patients (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  primary_provider_id  UUID        REFERENCES providers(id) ON DELETE SET NULL,
  mrn                  VARCHAR(50) NOT NULL,  -- Medical Record Number
  first_name           VARCHAR(120) NOT NULL,
  last_name            VARCHAR(120) NOT NULL,
  middle_name          VARCHAR(120),
  date_of_birth        DATE        NOT NULL,
  gender               gender      NOT NULL DEFAULT 'unknown',
  ssn_last_four        CHAR(4),  -- never store full SSN in application DB
  email                VARCHAR(320),
  phone                phone_number,
  phone_mobile         phone_number,
  address1             VARCHAR(500),
  address2             VARCHAR(500),
  city                 VARCHAR(200),
  state                CHAR(2),
  zip                  us_zip_code,
  country_code         CHAR(2)     NOT NULL DEFAULT 'US',
  preferred_language   VARCHAR(10) NOT NULL DEFAULT 'en',
  race                 VARCHAR(100),
  ethnicity            VARCHAR(100),
  blood_type           VARCHAR(5),
  allergies            TEXT[]      NOT NULL DEFAULT '{}',
  medical_history      JSONB       NOT NULL DEFAULT '{}',
  emergency_contacts   JSONB       NOT NULL DEFAULT '[]',
  advance_directive    BOOLEAN     NOT NULL DEFAULT FALSE,
  portal_access        BOOLEAN     NOT NULL DEFAULT FALSE,
  portal_last_login    TIMESTAMPTZ,
  consent_given_at     TIMESTAMPTZ,
  deleted_at           TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, mrn)
);

CREATE TABLE patient_contacts (
  id           BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  patient_id   UUID        NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  relationship VARCHAR(50) NOT NULL,  -- 'spouse', 'parent', 'child', etc.
  name         VARCHAR(255) NOT NULL,
  phone        phone_number NOT NULL,
  email        VARCHAR(320),
  is_emergency BOOLEAN     NOT NULL DEFAULT FALSE,
  is_authorized BOOLEAN    NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Insurance ─────────────────────────────────────────────────
CREATE TABLE insurance_plans (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  payer_id       VARCHAR(100) NOT NULL,
  payer_name     VARCHAR(300) NOT NULL,
  plan_name      VARCHAR(300) NOT NULL,
  plan_type      VARCHAR(50)  NOT NULL,  -- 'HMO', 'PPO', 'EPO', 'HDHP', etc.
  group_number   VARCHAR(100),
  network_type   VARCHAR(100),
  is_active      BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE patient_insurance (
  id                BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  patient_id        UUID        NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  insurance_plan_id UUID        NOT NULL REFERENCES insurance_plans(id),
  member_id         VARCHAR(100) NOT NULL,
  group_number      VARCHAR(100),
  coverage_period   daterange   NOT NULL,
  is_primary        BOOLEAN     NOT NULL DEFAULT TRUE,
  copay_amount      NUMERIC(10,2),
  deductible_amount NUMERIC(10,2),
  out_of_pocket_max NUMERIC(10,2),
  subscriber_name   VARCHAR(255),
  subscriber_dob    DATE,
  subscriber_relation VARCHAR(50),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Appointments & Encounters ─────────────────────────────────
CREATE TABLE appointments (
  id              UUID                 PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID                 NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  patient_id      UUID                 NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  provider_id     UUID                 NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  status          appointment_status   NOT NULL DEFAULT 'scheduled',
  type            VARCHAR(100)         NOT NULL DEFAULT 'office_visit',
  scheduled_at    TIMESTAMPTZ          NOT NULL,
  duration_min    SMALLINT             NOT NULL DEFAULT 30,
  reason          TEXT,
  notes           TEXT,
  location        VARCHAR(300),
  is_telemedicine BOOLEAN              NOT NULL DEFAULT FALSE,
  meeting_url     TEXT,
  reminder_sent   BOOLEAN              NOT NULL DEFAULT FALSE,
  cancelled_reason TEXT,
  cancelled_by    UUID                 REFERENCES providers(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ          NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ          NOT NULL DEFAULT NOW(),
  UNIQUE (provider_id, scheduled_at)
);

CREATE TABLE encounters (
  id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID            NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  appointment_id  UUID            REFERENCES appointments(id) ON DELETE SET NULL,
  patient_id      UUID            NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  provider_id     UUID            NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  type            encounter_type  NOT NULL DEFAULT 'outpatient',
  chief_complaint TEXT,
  assessment      TEXT,
  plan            TEXT,
  hpi             TEXT,  -- History of Present Illness
  ros             JSONB  NOT NULL DEFAULT '{}',  -- Review of Systems
  physical_exam   JSONB  NOT NULL DEFAULT '{}',
  started_at      TIMESTAMPTZ     NOT NULL,
  ended_at        TIMESTAMPTZ,
  signed_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- ── Diagnoses ─────────────────────────────────────────────────
CREATE TABLE diagnosis_codes (
  code        icd10_code  PRIMARY KEY,
  description VARCHAR(500) NOT NULL,
  category    VARCHAR(200),
  is_billable BOOLEAN     NOT NULL DEFAULT TRUE
);

CREATE TABLE encounter_diagnoses (
  encounter_id     UUID        NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
  diagnosis_code   icd10_code  NOT NULL REFERENCES diagnosis_codes(code),
  is_primary       BOOLEAN     NOT NULL DEFAULT FALSE,
  sequence         SMALLINT    NOT NULL DEFAULT 1,
  onset_date       DATE,
  notes            TEXT,
  PRIMARY KEY (encounter_id, diagnosis_code)
);

-- ── Medications & Prescriptions ───────────────────────────────
CREATE TABLE medications (
  id             BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ndc_code       VARCHAR(20) UNIQUE,  -- National Drug Code
  name           VARCHAR(300) NOT NULL,
  generic_name   VARCHAR(300),
  brand_names    TEXT[]      NOT NULL DEFAULT '{}',
  drug_class     VARCHAR(200),
  dosage_form    VARCHAR(100),  -- 'tablet', 'capsule', 'liquid', etc.
  strength       VARCHAR(100),
  unit           VARCHAR(50),
  is_controlled  BOOLEAN     NOT NULL DEFAULT FALSE,
  schedule       SMALLINT,  -- DEA Schedule I-V
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE prescriptions (
  id              UUID                 PRIMARY KEY DEFAULT gen_random_uuid(),
  encounter_id    UUID                 NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
  patient_id      UUID                 NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  prescriber_id   UUID                 NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  medication_id   BIGINT               NOT NULL REFERENCES medications(id),
  status          prescription_status  NOT NULL DEFAULT 'active',
  dosage          VARCHAR(200)         NOT NULL,
  frequency       VARCHAR(200)         NOT NULL,
  route           VARCHAR(100)         NOT NULL DEFAULT 'oral',
  quantity        NUMERIC(10,2)        NOT NULL,
  refills         SMALLINT             NOT NULL DEFAULT 0,
  refills_remaining SMALLINT           NOT NULL DEFAULT 0,
  days_supply     SMALLINT,
  instructions    TEXT,
  start_date      DATE                 NOT NULL,
  end_date        DATE,
  discontinued_at TIMESTAMPTZ,
  discontinued_reason TEXT,
  created_at      TIMESTAMPTZ          NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ          NOT NULL DEFAULT NOW()
);

CREATE TABLE medication_administrations (
  id              BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  prescription_id UUID        NOT NULL REFERENCES prescriptions(id) ON DELETE CASCADE,
  encounter_id    UUID        REFERENCES encounters(id) ON DELETE SET NULL,
  administered_by UUID        NOT NULL REFERENCES providers(id),
  administered_at TIMESTAMPTZ NOT NULL,
  dosage          VARCHAR(200) NOT NULL,
  route           VARCHAR(100) NOT NULL,
  site            VARCHAR(100),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Vitals ───────────────────────────────────────────────────
CREATE TABLE vitals (
  id              BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  encounter_id    UUID        NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
  patient_id      UUID        NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  recorded_by     UUID        NOT NULL REFERENCES providers(id),
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  height_cm       NUMERIC(5,1),
  weight_kg       NUMERIC(6,2),
  bmi             NUMERIC(5,2) GENERATED ALWAYS AS (
    CASE WHEN height_cm > 0 AND weight_kg > 0
         THEN ROUND((weight_kg / ((height_cm/100)^2))::NUMERIC, 2)
    END
  ) STORED,
  systolic_bp     SMALLINT CHECK (systolic_bp BETWEEN 40 AND 300),
  diastolic_bp    SMALLINT CHECK (diastolic_bp BETWEEN 20 AND 200),
  heart_rate      SMALLINT CHECK (heart_rate BETWEEN 20 AND 300),
  respiratory_rate SMALLINT,
  temperature_c   NUMERIC(4,1),
  spo2_pct        NUMERIC(4,1) CHECK (spo2_pct BETWEEN 0 AND 100),
  pain_scale      SMALLINT     CHECK (pain_scale BETWEEN 0 AND 10),
  notes           TEXT
);

-- ── Labs ─────────────────────────────────────────────────────
CREATE TABLE lab_orders (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  encounter_id    UUID        NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
  patient_id      UUID        NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  ordering_provider_id UUID   NOT NULL REFERENCES providers(id),
  status          lab_status  NOT NULL DEFAULT 'ordered',
  priority        VARCHAR(20) NOT NULL DEFAULT 'routine',
  specimen_type   VARCHAR(100),
  collected_at    TIMESTAMPTZ,
  collection_site VARCHAR(200),
  lab_name        VARCHAR(300),
  external_order_id VARCHAR(100),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE lab_results (
  id              BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lab_order_id    UUID        NOT NULL REFERENCES lab_orders(id) ON DELETE CASCADE,
  test_code       VARCHAR(100) NOT NULL,
  test_name       VARCHAR(300) NOT NULL,
  value           TEXT        NOT NULL,
  value_numeric   NUMERIC(15,4),
  unit            VARCHAR(100),
  reference_range VARCHAR(200),
  interpretation VARCHAR(20), -- 'H', 'L', 'N', 'A', 'C' (high/low/normal/abnormal/critical)
  is_abnormal     BOOLEAN     NOT NULL DEFAULT FALSE,
  is_critical     BOOLEAN     NOT NULL DEFAULT FALSE,
  resulted_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Billing ───────────────────────────────────────────────────
CREATE TABLE billing_claims (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  encounter_id        UUID        NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
  patient_id          UUID        NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  insurance_record_id BIGINT      REFERENCES patient_insurance(id) ON DELETE SET NULL,
  status              claim_status NOT NULL DEFAULT 'draft',
  claim_number        VARCHAR(100) UNIQUE,
  service_date        DATE        NOT NULL,
  submission_date     DATE,
  total_billed        NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_allowed       NUMERIC(12,2),
  total_paid          NUMERIC(12,2) NOT NULL DEFAULT 0,
  patient_responsibility NUMERIC(12,2) NOT NULL DEFAULT 0,
  denial_reason       TEXT,
  notes               TEXT,
  submitted_at        TIMESTAMPTZ,
  adjudicated_at      TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE claim_line_items (
  id              BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  claim_id        UUID        NOT NULL REFERENCES billing_claims(id) ON DELETE CASCADE,
  procedure_code  VARCHAR(20) NOT NULL,
  diagnosis_code  icd10_code  REFERENCES diagnosis_codes(code),
  description     TEXT,
  quantity        NUMERIC(8,2) NOT NULL DEFAULT 1,
  unit_price      NUMERIC(12,2) NOT NULL,
  billed_amount   NUMERIC(12,2) NOT NULL,
  allowed_amount  NUMERIC(12,2),
  paid_amount     NUMERIC(12,2),
  modifier        VARCHAR(10),
  place_of_service CHAR(2),
  sequence        SMALLINT    NOT NULL DEFAULT 1
);

-- ── Audit trail (full row snapshots) ─────────────────────────
CREATE TABLE audit_trail (
  id              BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id UUID        REFERENCES organizations(id) ON DELETE SET NULL,
  user_id         UUID        REFERENCES providers(id) ON DELETE SET NULL,
  action          VARCHAR(20) NOT NULL,  -- 'INSERT', 'UPDATE', 'DELETE'
  table_name      VARCHAR(100) NOT NULL,
  record_id       TEXT        NOT NULL,
  row_data        JSONB       NOT NULL,  -- full row snapshot at time of event
  changed_fields  JSONB,
  ip_address      INET,
  user_agent      TEXT,
  reason          TEXT,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_trail_record ON audit_trail (table_name, record_id, occurred_at DESC);
CREATE INDEX idx_audit_trail_user   ON audit_trail (user_id, occurred_at DESC);
CREATE INDEX idx_audit_trail_data   ON audit_trail USING GIN (row_data);

-- ── Audit trigger ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION capture_audit_row()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO audit_trail (action, table_name, record_id, row_data, changed_fields)
  VALUES (
    TG_OP,
    TG_TABLE_NAME,
    COALESCE(NEW.id::TEXT, OLD.id::TEXT),
    CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END,
    CASE WHEN TG_OP = 'UPDATE'
         THEN jsonb_diff_val(to_jsonb(OLD), to_jsonb(NEW))
    END
  );
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Example: enable audit on patients table
CREATE TRIGGER trg_patients_audit
  AFTER INSERT OR UPDATE OR DELETE ON patients
  FOR EACH ROW EXECUTE FUNCTION capture_audit_row();

-- ── Inherited table example (INHERITS) ───────────────────────
-- Base person record — shared columns via inheritance
CREATE TABLE persons (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name VARCHAR(120) NOT NULL,
  last_name  VARCHAR(120) NOT NULL,
  email      VARCHAR(320),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Inherits all columns from persons
CREATE TABLE staff (
  department VARCHAR(100),
  hire_date  DATE NOT NULL
) INHERITS (persons);

-- ── Indexes ───────────────────────────────────────────────────
CREATE INDEX idx_patients_org_name ON patients (organization_id, last_name, first_name)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_appointments_provider_time ON appointments (provider_id, scheduled_at)
  WHERE status NOT IN ('cancelled', 'no_show');
CREATE INDEX idx_prescriptions_patient ON prescriptions (patient_id, status, start_date);
CREATE INDEX idx_patients_medical_history ON patients USING GIN (medical_history);
