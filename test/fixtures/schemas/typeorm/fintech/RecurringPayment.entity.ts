import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  Index,
} from "typeorm";
import { Account } from "./Account.entity.js";

export enum RecurringPaymentStatus {
  ACTIVE = "active",
  PAUSED = "paused",
  COMPLETED = "completed",
  FAILED = "failed",
  CANCELLED = "cancelled",
}

export enum RecurringFrequency {
  DAILY = "daily",
  WEEKLY = "weekly",
  BI_WEEKLY = "bi_weekly",
  MONTHLY = "monthly",
  QUARTERLY = "quarterly",
  ANNUALLY = "annually",
}

@Entity("recurring_payments")
@Index(["accountId", "status"])
@Index(["nextRunAt", "status"])
export class RecurringPayment {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "account_id" })
  accountId!: string;

  @Column({ type: "uuid", nullable: true, name: "beneficiary_id" })
  beneficiaryId?: string;

  @Column({ type: "varchar", length: 255 })
  name!: string;

  @Column({ type: "text", nullable: true })
  description?: string;

  @Column({ type: "decimal", precision: 19, scale: 4 })
  amount!: string;

  @Column({ type: "char", length: 3 })
  currency!: string;

  @Column({
    type: "enum",
    enum: RecurringFrequency,
    default: RecurringFrequency.MONTHLY,
  })
  frequency!: RecurringFrequency;

  @Column({
    type: "enum",
    enum: RecurringPaymentStatus,
    default: RecurringPaymentStatus.ACTIVE,
  })
  status!: RecurringPaymentStatus;

  // Schedule config stored as simple-json (not JSONB — example of different column type)
  @Column({ type: "simple-json", nullable: true })
  schedule?: {
    dayOfMonth?: number;
    dayOfWeek?: number;
    startDate: string;
    endDate?: string;
    maxOccurrences?: number;
  };

  @Column({ type: "int", default: 0, name: "run_count" })
  runCount!: number;

  @Column({ type: "int", nullable: true, name: "max_run_count" })
  maxRunCount?: number;

  @Column({ type: "timestamp with time zone", nullable: true, name: "last_run_at" })
  lastRunAt?: Date;

  @Column({ type: "timestamp with time zone", nullable: true, name: "next_run_at" })
  nextRunAt?: Date;

  @Column({ type: "timestamp with time zone", nullable: true, name: "starts_at" })
  startsAt?: Date;

  @Column({ type: "timestamp with time zone", nullable: true, name: "ends_at" })
  endsAt?: Date;

  @Column({ type: "int", default: 0, name: "failure_count" })
  failureCount!: number;

  @Column({ type: "varchar", length: 500, nullable: true, name: "last_failure_reason" })
  lastFailureReason?: string;

  @Column({ type: "jsonb", nullable: true })
  metadata?: Record<string, unknown>;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;

  @DeleteDateColumn({ name: "deleted_at" })
  deletedAt?: Date;

  @ManyToOne(() => Account, { onDelete: "CASCADE" })
  @JoinColumn({ name: "account_id" })
  account!: Account;
}
