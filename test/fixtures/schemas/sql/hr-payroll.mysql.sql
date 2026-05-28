-- ============================================================
-- HR & Payroll System — MySQL
-- Covers: ENUM inline type, SET type, DECIMAL for salary,
-- VIRTUAL generated column, STORED generated column,
-- SPATIAL INDEX + POINT, ON UPDATE CURRENT_TIMESTAMP,
-- CHAR(36) UUID pattern, self-ref manager_id / parent dept.
-- ============================================================

CREATE TABLE `companies` (
  `id`           INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  `name`         VARCHAR(300)    NOT NULL,
  `legal_name`   VARCHAR(300),
  `tax_id`       VARCHAR(50),
  `industry`     VARCHAR(100),
  `website`      VARCHAR(500),
  `logo_url`     VARCHAR(500),
  `founded_year` SMALLINT UNSIGNED,
  `employee_count` INT UNSIGNED  NOT NULL DEFAULT 0,
  `is_active`    TINYINT(1)      NOT NULL DEFAULT 1,
  `settings`     JSON,
  `created_at`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_tax_id` (`tax_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `departments` (
  `id`            INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `company_id`    INT UNSIGNED  NOT NULL,
  `parent_id`     INT UNSIGNED  DEFAULT NULL,  -- nullable self-ref for sub-departments
  `name`          VARCHAR(200)  NOT NULL,
  `code`          VARCHAR(20)   NOT NULL,
  `description`   TEXT,
  `budget`        DECIMAL(15,2),
  `cost_center`   VARCHAR(50),
  `location`      VARCHAR(200),
  `office_coords` POINT,  -- GPS coordinates of office
  `is_active`     TINYINT(1)    NOT NULL DEFAULT 1,
  `created_at`    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_dept_code` (`company_id`, `code`),
  KEY `idx_parent` (`parent_id`),
  SPATIAL INDEX `sidx_office_coords` (`office_coords`),
  FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE CASCADE,
  FOREIGN KEY (`parent_id`) REFERENCES `departments` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `job_levels` (
  `id`          TINYINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `code`        VARCHAR(20)      NOT NULL UNIQUE,  -- 'IC1','IC2','M1','M2','VP','C'
  `title`       VARCHAR(100)     NOT NULL,
  `min_salary`  DECIMAL(12,2),
  `max_salary`  DECIMAL(12,2),
  `is_manager`  TINYINT(1)       NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `positions` (
  `id`             INT UNSIGNED   NOT NULL AUTO_INCREMENT,
  `department_id`  INT UNSIGNED   NOT NULL,
  `job_level_id`   TINYINT UNSIGNED NOT NULL,
  `title`          VARCHAR(200)   NOT NULL,
  `description`    TEXT,
  `is_open`        TINYINT(1)     NOT NULL DEFAULT 0,
  `headcount`      TINYINT UNSIGNED NOT NULL DEFAULT 1,
  `created_at`     DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  FOREIGN KEY (`department_id`) REFERENCES `departments` (`id`) ON DELETE CASCADE,
  FOREIGN KEY (`job_level_id`)  REFERENCES `job_levels`  (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `employees` (
  `id`              CHAR(36)     NOT NULL,  -- UUID stored as CHAR(36)
  `company_id`      INT UNSIGNED NOT NULL,
  `department_id`   INT UNSIGNED,
  `position_id`     INT UNSIGNED,
  `manager_id`      CHAR(36)     DEFAULT NULL,  -- nullable self-ref
  `employee_number` VARCHAR(20)  NOT NULL,
  `first_name`      VARCHAR(120) NOT NULL,
  `last_name`       VARCHAR(120) NOT NULL,
  `middle_name`     VARCHAR(120),
  `full_name`       VARCHAR(365) GENERATED ALWAYS AS (
    TRIM(CONCAT(first_name, ' ', COALESCE(middle_name, ''), ' ', last_name))
  ) VIRTUAL,
  `preferred_name`  VARCHAR(120),
  `email`           VARCHAR(320) NOT NULL,
  `work_email`      VARCHAR(320),
  `phone`           VARCHAR(30),
  `mobile`          VARCHAR(30),
  `gender`          ENUM('male','female','non_binary','other','prefer_not_to_say'),
  `birth_date`      DATE,
  `age`             TINYINT UNSIGNED GENERATED ALWAYS AS (
    TIMESTAMPDIFF(YEAR, birth_date, CURDATE())
  ) VIRTUAL,
  `nationality`     VARCHAR(100),
  `work_permit`     VARCHAR(100),
  `work_permit_expiry` DATE,
  `address1`        VARCHAR(500),
  `city`            VARCHAR(200),
  `state`           VARCHAR(100),
  `country_code`    CHAR(2)      NOT NULL DEFAULT 'US',
  `hire_date`       DATE         NOT NULL,
  `probation_end_date` DATE,
  `termination_date` DATE,
  `status`          ENUM('active','on_leave','terminated','contractor','intern') NOT NULL DEFAULT 'active',
  `employment_type` ENUM('full_time','part_time','contract','temporary','intern') NOT NULL DEFAULT 'full_time',
  `work_days`       SET('MON','TUE','WED','THU','FRI','SAT','SUN') NOT NULL DEFAULT 'MON,TUE,WED,THU,FRI',
  `remote_type`     ENUM('onsite','hybrid','fully_remote') NOT NULL DEFAULT 'onsite',
  `tax_id`          VARCHAR(50),
  `bank_account`    VARCHAR(100),  -- stored encrypted in practice
  `bank_routing`    VARCHAR(20),
  `emergency_contact_name` VARCHAR(255),
  `emergency_contact_phone` VARCHAR(30),
  `metadata`        JSON,
  `created_at`      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_employee_number` (`company_id`, `employee_number`),
  UNIQUE KEY `uk_email` (`email`),
  KEY `idx_department` (`department_id`),
  KEY `idx_manager`    (`manager_id`),
  KEY `idx_status`     (`company_id`, `status`),
  FOREIGN KEY (`company_id`)    REFERENCES `companies`   (`id`) ON DELETE CASCADE,
  FOREIGN KEY (`department_id`) REFERENCES `departments` (`id`) ON DELETE SET NULL,
  FOREIGN KEY (`position_id`)   REFERENCES `positions`   (`id`) ON DELETE SET NULL,
  FOREIGN KEY (`manager_id`)    REFERENCES `employees`   (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `employee_documents` (
  `id`          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `employee_id` CHAR(36)     NOT NULL,
  `type`        ENUM('offer_letter','contract','id_document','tax_form','performance_review',
                     'warning_letter','termination_letter','other') NOT NULL,
  `title`       VARCHAR(255) NOT NULL,
  `url`         TEXT         NOT NULL,
  `mime_type`   VARCHAR(100) NOT NULL,
  `size_bytes`  BIGINT UNSIGNED,
  `uploaded_by` CHAR(36),
  `uploaded_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_employee` (`employee_id`),
  FOREIGN KEY (`employee_id`) REFERENCES `employees` (`id`) ON DELETE CASCADE,
  FOREIGN KEY (`uploaded_by`) REFERENCES `employees` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `contracts` (
  `id`              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `employee_id`     CHAR(36)     NOT NULL,
  `type`            ENUM('employment','amendment','renewal','termination') NOT NULL,
  `start_date`      DATE         NOT NULL,
  `end_date`        DATE,
  `salary`          DECIMAL(12,2) NOT NULL,
  `currency`        CHAR(3)      NOT NULL DEFAULT 'USD',
  `hours_per_week`  DECIMAL(4,1) NOT NULL DEFAULT 40.0,
  `probation_days`  SMALLINT     NOT NULL DEFAULT 90,
  `signed_at`       DATETIME,
  `document_url`    TEXT,
  `notes`           TEXT,
  `created_at`      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  FOREIGN KEY (`employee_id`) REFERENCES `employees` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `salaries` (
  `id`            INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `employee_id`   CHAR(36)      NOT NULL,
  `amount`        DECIMAL(12,2) NOT NULL,
  `currency`      CHAR(3)       NOT NULL DEFAULT 'USD',
  `pay_frequency` ENUM('weekly','bi_weekly','semi_monthly','monthly','annual') NOT NULL DEFAULT 'bi_weekly',
  `effective_from` DATE         NOT NULL,
  `effective_to`  DATE,
  `reason`        VARCHAR(200),
  `created_by`    CHAR(36),
  `created_at`    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_employee_salary` (`employee_id`, `effective_from`),
  FOREIGN KEY (`employee_id`) REFERENCES `employees` (`id`) ON DELETE CASCADE,
  FOREIGN KEY (`created_by`)  REFERENCES `employees` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `payroll_periods` (
  `id`           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `company_id`   INT UNSIGNED NOT NULL,
  `name`         VARCHAR(100) NOT NULL,
  `start_date`   DATE         NOT NULL,
  `end_date`     DATE         NOT NULL,
  `pay_date`     DATE         NOT NULL,
  `status`       ENUM('open','processing','closed','cancelled') NOT NULL DEFAULT 'open',
  `created_at`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_period_dates` (`company_id`, `start_date`, `end_date`),
  FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `payroll_runs` (
  `id`              INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `period_id`       INT UNSIGNED  NOT NULL,
  `run_by`          CHAR(36),
  `status`          ENUM('draft','processing','approved','paid','cancelled') NOT NULL DEFAULT 'draft',
  `total_gross`     DECIMAL(15,2) NOT NULL DEFAULT 0,
  `total_deductions` DECIMAL(15,2) NOT NULL DEFAULT 0,
  `total_net`       DECIMAL(15,2) NOT NULL DEFAULT 0,
  `total_tax`       DECIMAL(15,2) NOT NULL DEFAULT 0,
  `employee_count`  INT UNSIGNED  NOT NULL DEFAULT 0,
  `approved_by`     CHAR(36),
  `approved_at`     DATETIME,
  `paid_at`         DATETIME,
  `notes`           TEXT,
  `created_at`      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  FOREIGN KEY (`period_id`)   REFERENCES `payroll_periods` (`id`) ON DELETE CASCADE,
  FOREIGN KEY (`run_by`)      REFERENCES `employees` (`id`) ON DELETE SET NULL,
  FOREIGN KEY (`approved_by`) REFERENCES `employees` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `payroll_items` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `payroll_run_id`  INT UNSIGNED    NOT NULL,
  `employee_id`     CHAR(36)        NOT NULL,
  `gross_pay`       DECIMAL(12,2)   NOT NULL,
  `federal_tax`     DECIMAL(10,2)   NOT NULL DEFAULT 0,
  `state_tax`       DECIMAL(10,2)   NOT NULL DEFAULT 0,
  `social_security` DECIMAL(10,2)   NOT NULL DEFAULT 0,
  `medicare`        DECIMAL(10,2)   NOT NULL DEFAULT 0,
  `health_insurance` DECIMAL(10,2)  NOT NULL DEFAULT 0,
  `retirement_401k`  DECIMAL(10,2)  NOT NULL DEFAULT 0,
  `other_deductions` DECIMAL(10,2)  NOT NULL DEFAULT 0,
  `total_deductions` DECIMAL(10,2)  NOT NULL DEFAULT 0,
  `net_pay`         DECIMAL(12,2)   NOT NULL,
  `hours_worked`    DECIMAL(6,2),
  `overtime_hours`  DECIMAL(6,2)    NOT NULL DEFAULT 0,
  `bonus`           DECIMAL(10,2)   NOT NULL DEFAULT 0,
  `commission`      DECIMAL(10,2)   NOT NULL DEFAULT 0,
  `payment_method`  ENUM('direct_deposit','check','cash') NOT NULL DEFAULT 'direct_deposit',
  `notes`           TEXT,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_run_employee` (`payroll_run_id`, `employee_id`),
  FOREIGN KEY (`payroll_run_id`) REFERENCES `payroll_runs` (`id`) ON DELETE CASCADE,
  FOREIGN KEY (`employee_id`)    REFERENCES `employees`    (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `time_off_policies` (
  `id`                INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `company_id`        INT UNSIGNED  NOT NULL,
  `name`              VARCHAR(200)  NOT NULL,
  `type`              ENUM('vacation','sick','personal','parental','bereavement','other') NOT NULL,
  `accrual_method`    ENUM('up_front','accrued','unlimited') NOT NULL DEFAULT 'accrued',
  `days_per_year`     DECIMAL(6,2),
  `max_carryover`     DECIMAL(6,2),
  `max_balance`       DECIMAL(6,2),
  `requires_approval` TINYINT(1)    NOT NULL DEFAULT 1,
  `min_days_notice`   SMALLINT      NOT NULL DEFAULT 0,
  `is_active`         TINYINT(1)    NOT NULL DEFAULT 1,
  `created_at`        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `time_off_balances` (
  `id`            INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `employee_id`   CHAR(36)      NOT NULL,
  `policy_id`     INT UNSIGNED  NOT NULL,
  `year`          SMALLINT      NOT NULL,
  `balance`       DECIMAL(6,2)  NOT NULL DEFAULT 0,
  `accrued`       DECIMAL(6,2)  NOT NULL DEFAULT 0,
  `used`          DECIMAL(6,2)  NOT NULL DEFAULT 0,
  `pending`       DECIMAL(6,2)  NOT NULL DEFAULT 0,
  `carryover`     DECIMAL(6,2)  NOT NULL DEFAULT 0,
  `updated_at`    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_employee_policy_year` (`employee_id`, `policy_id`, `year`),
  FOREIGN KEY (`employee_id`) REFERENCES `employees`         (`id`) ON DELETE CASCADE,
  FOREIGN KEY (`policy_id`)   REFERENCES `time_off_policies` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `time_off_requests` (
  `id`            INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `employee_id`   CHAR(36)      NOT NULL,
  `policy_id`     INT UNSIGNED  NOT NULL,
  `approver_id`   CHAR(36),
  `start_date`    DATE          NOT NULL,
  `end_date`      DATE          NOT NULL,
  `days`          DECIMAL(6,2)  NOT NULL,
  `half_day`      TINYINT(1)    NOT NULL DEFAULT 0,
  `status`        ENUM('pending','approved','rejected','cancelled') NOT NULL DEFAULT 'pending',
  `reason`        TEXT,
  `rejection_reason` TEXT,
  `approved_at`   DATETIME,
  `created_at`    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_employee_dates` (`employee_id`, `start_date`, `end_date`),
  FOREIGN KEY (`employee_id`) REFERENCES `employees`         (`id`) ON DELETE CASCADE,
  FOREIGN KEY (`policy_id`)   REFERENCES `time_off_policies` (`id`),
  FOREIGN KEY (`approver_id`) REFERENCES `employees`         (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `attendance_records` (
  `id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `employee_id`  CHAR(36)        NOT NULL,
  `date`         DATE            NOT NULL,
  `clock_in`     DATETIME,
  `clock_out`    DATETIME,
  `break_minutes` SMALLINT       NOT NULL DEFAULT 0,
  `total_hours`   DECIMAL(5,2) GENERATED ALWAYS AS (
    CASE WHEN clock_in IS NOT NULL AND clock_out IS NOT NULL
         THEN ROUND((TIMESTAMPDIFF(MINUTE, clock_in, clock_out) - break_minutes) / 60.0, 2)
    END
  ) STORED,
  `overtime_hours` DECIMAL(5,2)  NOT NULL DEFAULT 0,
  `status`       ENUM('present','absent','late','half_day','on_leave','holiday','remote') NOT NULL DEFAULT 'present',
  `notes`        VARCHAR(500),
  `created_at`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_employee_date` (`employee_id`, `date`),
  FOREIGN KEY (`employee_id`) REFERENCES `employees` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `performance_reviews` (
  `id`              INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `employee_id`     CHAR(36)      NOT NULL,
  `reviewer_id`     CHAR(36)      NOT NULL,
  `period_start`    DATE          NOT NULL,
  `period_end`      DATE          NOT NULL,
  `review_date`     DATE,
  `status`          ENUM('draft','self_review','manager_review','completed','acknowledged') NOT NULL DEFAULT 'draft',
  `overall_rating`  DECIMAL(3,1)  CHECK (`overall_rating` BETWEEN 1.0 AND 5.0),
  `goals_met`       TINYINT(1),
  `goals_data`      JSON,
  `competencies`    JSON,
  `summary`         TEXT,
  `improvement_plan` TEXT,
  `acknowledged_at` DATETIME,
  `created_at`      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  FOREIGN KEY (`employee_id`) REFERENCES `employees` (`id`) ON DELETE CASCADE,
  FOREIGN KEY (`reviewer_id`) REFERENCES `employees` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
