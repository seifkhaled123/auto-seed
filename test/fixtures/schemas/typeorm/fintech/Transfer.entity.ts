import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  OneToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
  VersionColumn,
  Unique,
  Index,
} from "typeorm";
import { Transaction } from "./Transaction.entity.js";

export enum TransferStatus {
  INITIATED = "initiated",
  PENDING_APPROVAL = "pending_approval",
  APPROVED = "approved",
  PROCESSING = "processing",
  COMPLETED = "completed",
  FAILED = "failed",
  CANCELLED = "cancelled",
  RETURNED = "returned",
}

export enum TransferMethod {
  INTERNAL = "internal",    // between accounts on this platform
  WIRE = "wire",            // international wire
  ACH = "ach",              // US domestic ACH
  SEPA = "sepa",            // EU SEPA
  SWIFT = "swift",          // international SWIFT
  INSTANT = "instant",      // real-time payment networks
  CHECK = "check",
}

@Entity("transfers")
@Unique(["idempotencyKey"])
@Index(["status", "createdAt"])
export class Transfer {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", nullable: true, name: "transaction_id" })
  transactionId?: string;

  // Idempotency key — client-provided to prevent duplicate transfers
  @Column({ type: "uuid", name: "idempotency_key" })
  idempotencyKey!: string;

  @Column({ type: "uuid", name: "source_account_id" })
  sourceAccountId!: string;

  @Column({ type: "uuid", name: "destination_account_id", nullable: true })
  destinationAccountId?: string;

  @Column({ type: "uuid", name: "beneficiary_id", nullable: true })
  beneficiaryId?: string;

  @Column({
    type: "enum",
    enum: TransferStatus,
    default: TransferStatus.INITIATED,
  })
  status!: TransferStatus;

  @Column({
    type: "enum",
    enum: TransferMethod,
    default: TransferMethod.INTERNAL,
  })
  method!: TransferMethod;

  @Column({ type: "decimal", precision: 19, scale: 4 })
  amount!: string;

  @Column({ type: "char", length: 3 })
  currency!: string;

  @Column({ type: "decimal", precision: 19, scale: 4, nullable: true, name: "fx_amount" })
  fxAmount?: string;  // converted amount in destination currency

  @Column({ type: "char", length: 3, nullable: true, name: "fx_currency" })
  fxCurrency?: string;

  @Column({ type: "decimal", precision: 12, scale: 6, nullable: true, name: "fx_rate" })
  fxRate?: string;

  @Column({ type: "decimal", precision: 19, scale: 4, default: "0" })
  fee!: string;

  @Column({ type: "varchar", length: 500, nullable: true })
  description?: string;

  @Column({ type: "varchar", length: 100, nullable: true, name: "gateway_ref" })
  gatewayRef?: string;

  @Column({ type: "jsonb", nullable: true, name: "routing_details" })
  routingDetails?: Record<string, unknown>;

  @Column({ type: "jsonb", nullable: true, name: "compliance_data" })
  complianceData?: Record<string, unknown>;

  @Column({ type: "varchar", length: 200, nullable: true, name: "failure_reason" })
  failureReason?: string;

  @Column({ type: "timestamp with time zone", nullable: true, name: "scheduled_at" })
  scheduledAt?: Date;

  @Column({ type: "timestamp with time zone", nullable: true, name: "completed_at" })
  completedAt?: Date;

  // Optimistic locking — prevents race conditions in transfer state machine
  @VersionColumn()
  version!: number;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;

  @OneToOne(() => Transaction, { nullable: true })
  @JoinColumn({ name: "transaction_id" })
  transaction?: Transaction;
}
