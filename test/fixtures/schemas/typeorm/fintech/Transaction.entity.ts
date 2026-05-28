import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  Index,
} from "typeorm";
import { Account } from "./Account.entity.js";

export enum TransactionType {
  TRANSFER = "transfer",
  PAYMENT = "payment",
  DEPOSIT = "deposit",
  WITHDRAWAL = "withdrawal",
  FEE = "fee",
  REFUND = "refund",
  REVERSAL = "reversal",
  INTEREST = "interest",
  ADJUSTMENT = "adjustment",
}

export enum TransactionStatus {
  INITIATED = "initiated",
  PENDING = "pending",
  PROCESSING = "processing",
  COMPLETED = "completed",
  FAILED = "failed",
  CANCELLED = "cancelled",
  REVERSED = "reversed",
}

// Append-only ledger table — rows are never updated after creation.
// Each row records a double-entry movement between two accounts.
@Entity("transactions")
@Index(["debitAccountId", "createdAt"])
@Index(["creditAccountId", "createdAt"])
@Index(["status", "createdAt"])
export class Transaction {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", nullable: true, name: "debit_account_id" })
  debitAccountId?: string;

  @Column({ type: "uuid", nullable: true, name: "credit_account_id" })
  creditAccountId?: string;

  @Column({
    type: "enum",
    enum: TransactionType,
  })
  type!: TransactionType;

  @Column({
    type: "enum",
    enum: TransactionStatus,
    default: TransactionStatus.INITIATED,
  })
  status!: TransactionStatus;

  @Column({ type: "decimal", precision: 19, scale: 4 })
  amount!: string;

  @Column({ type: "char", length: 3 })
  currency!: string;

  @Column({ type: "decimal", precision: 19, scale: 4, nullable: true, name: "exchange_rate" })
  exchangeRate?: string;

  @Column({ type: "decimal", precision: 19, scale: 4, default: "0" })
  fee!: string;

  // Snapshot balances at time of transaction (for audit trail)
  @Column({ type: "decimal", precision: 19, scale: 4, nullable: true, name: "debit_balance_before" })
  debitBalanceBefore?: string;

  @Column({ type: "decimal", precision: 19, scale: 4, nullable: true, name: "debit_balance_after" })
  debitBalanceAfter?: string;

  @Column({ type: "decimal", precision: 19, scale: 4, nullable: true, name: "credit_balance_before" })
  creditBalanceBefore?: string;

  @Column({ type: "decimal", precision: 19, scale: 4, nullable: true, name: "credit_balance_after" })
  creditBalanceAfter?: string;

  @Column({ type: "varchar", length: 500, nullable: true })
  description?: string;

  @Column({ type: "varchar", length: 100, nullable: true, name: "reference_number" })
  referenceNumber?: string;

  @Column({ type: "varchar", length: 50, nullable: true })
  channel?: string;  // 'app', 'api', 'pos', 'atm', 'wire'

  @Column({ type: "varchar", length: 100, nullable: true, name: "gateway_id" })
  gatewayId?: string;

  @Column({ type: "jsonb", nullable: true })
  metadata?: Record<string, unknown>;

  @Column({ type: "varchar", length: 100, nullable: true, name: "failure_code" })
  failureCode?: string;

  @Column({ type: "text", nullable: true, name: "failure_message" })
  failureMessage?: string;

  @Column({ type: "timestamp with time zone", nullable: true, name: "processed_at" })
  processedAt?: Date;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  // Two @ManyToOne to the same Account entity (different FK columns)
  @ManyToOne(() => Account, (account) => account.debitTransactions, {
    nullable: true,
    onDelete: "RESTRICT",
  })
  @JoinColumn({ name: "debit_account_id" })
  debitAccount?: Account;

  @ManyToOne(() => Account, (account) => account.creditTransactions, {
    nullable: true,
    onDelete: "RESTRICT",
  })
  @JoinColumn({ name: "credit_account_id" })
  creditAccount?: Account;
}
