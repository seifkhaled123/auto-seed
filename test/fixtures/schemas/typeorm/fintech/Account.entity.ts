import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  OneToMany,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  VersionColumn,
  Check,
  Index,
} from "typeorm";
import { Customer } from "./Customer.entity.js";
import { Card } from "./Card.entity.js";
import { Transaction } from "./Transaction.entity.js";

export enum AccountType {
  CHECKING = "checking",
  SAVINGS = "savings",
  INVESTMENT = "investment",
  CRYPTO = "crypto",
  BUSINESS = "business",
}

export enum AccountStatus {
  PENDING = "pending",
  ACTIVE = "active",
  RESTRICTED = "restricted",
  FROZEN = "frozen",
  CLOSED = "closed",
}

@Entity("accounts")
@Check('"balance" >= 0')
@Index(["customerId", "status"])
export class Account {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "customer_id" })
  customerId!: string;

  @Column({ type: "varchar", length: 30, unique: true, name: "account_number" })
  accountNumber!: string;

  @Column({ type: "varchar", length: 30, unique: true, name: "iban", nullable: true })
  iban?: string;

  @Column({ type: "varchar", length: 20, name: "routing_number", nullable: true })
  routingNumber?: string;

  @Column({
    type: "enum",
    enum: AccountType,
    default: AccountType.CHECKING,
  })
  type!: AccountType;

  @Column({
    type: "enum",
    enum: AccountStatus,
    default: AccountStatus.PENDING,
  })
  status!: AccountStatus;

  // Balance stored with full precision — CHECK constraint enforces >= 0
  @Column({ type: "decimal", precision: 19, scale: 4, default: "0" })
  balance!: string;  // returned as string by TypeORM for precision safety

  @Column({ type: "decimal", precision: 19, scale: 4, default: "0", name: "pending_balance" })
  pendingBalance!: string;

  @Column({ type: "decimal", precision: 19, scale: 4, nullable: true, name: "overdraft_limit" })
  overdraftLimit?: string;

  @Column({ type: "char", length: 3, default: "USD" })
  currency!: string;

  @Column({ type: "varchar", length: 200, nullable: true })
  nickname?: string;

  @Column({ type: "boolean", default: false, name: "is_default" })
  isDefault!: boolean;

  @Column({ type: "jsonb", nullable: true, name: "limits" })
  limits?: {
    dailyTransfer?: number;
    monthlyTransfer?: number;
    atm?: number;
  };

  @Column({ type: "timestamp with time zone", nullable: true, name: "closed_at" })
  closedAt?: Date;

  // Optimistic locking — critical for concurrent balance updates
  @VersionColumn()
  version!: number;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;

  // Soft delete when account is closed
  @DeleteDateColumn({ name: "deleted_at" })
  deletedAt?: Date;

  @ManyToOne(() => Customer, (customer) => customer.accounts, { onDelete: "CASCADE" })
  @JoinColumn({ name: "customer_id" })
  customer!: Customer;

  @OneToMany(() => Card, (card) => card.account)
  cards!: Card[];

  @OneToMany(() => Transaction, (tx) => tx.debitAccount)
  debitTransactions!: Transaction[];

  @OneToMany(() => Transaction, (tx) => tx.creditAccount)
  creditTransactions!: Transaction[];
}
