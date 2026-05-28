import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
  AfterLoad,
  Index,
} from "typeorm";
import { Account } from "./Account.entity.js";

export enum CardType {
  PHYSICAL_DEBIT = "physical_debit",
  VIRTUAL_DEBIT = "physical_credit",
  PHYSICAL_CREDIT = "virtual_debit",
  VIRTUAL_CREDIT = "virtual_credit",
  PREPAID = "prepaid",
}

export enum CardStatus {
  PENDING = "pending",
  ACTIVE = "active",
  FROZEN = "frozen",
  BLOCKED = "blocked",
  EXPIRED = "expired",
  CANCELLED = "cancelled",
}

@Entity("cards")
@Index(["accountId", "status"])
export class Card {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "account_id" })
  accountId!: string;

  @Column({
    type: "enum",
    enum: CardType,
    default: CardType.VIRTUAL_DEBIT,
  })
  type!: CardType;

  @Column({
    type: "enum",
    enum: CardStatus,
    default: CardStatus.PENDING,
  })
  status!: CardStatus;

  @Column({ type: "char", length: 4, name: "last_four" })
  lastFour!: string;

  @Column({ type: "varchar", length: 50, nullable: true })
  brand?: string;  // 'Visa', 'Mastercard', 'Amex'

  @Column({ type: "char", length: 2, name: "exp_month" })
  expMonth!: string;  // '01'–'12'

  @Column({ type: "char", length: 4, name: "exp_year" })
  expYear!: string;   // '2027'

  @Column({ type: "varchar", length: 255, name: "cardholder_name" })
  cardholderName!: string;

  // Tokenized card number (from payment gateway, not actual PAN)
  @Column({ generated: "uuid", type: "uuid", name: "network_token", nullable: true })
  networkToken?: string;

  @Column({ type: "varchar", length: 100, nullable: true, name: "gateway_card_id" })
  gatewayCardId?: string;

  @Column({ type: "boolean", default: false, name: "is_default" })
  isDefault!: boolean;

  @Column({ type: "boolean", default: true, name: "online_transactions" })
  onlineTransactions!: boolean;

  @Column({ type: "boolean", default: true, name: "international_transactions" })
  internationalTransactions!: boolean;

  @Column({ type: "jsonb", nullable: true, name: "spending_limits" })
  spendingLimits?: {
    daily?: number;
    monthly?: number;
    perTransaction?: number;
  };

  @Column({ type: "timestamp with time zone", nullable: true, name: "activated_at" })
  activatedAt?: Date;

  @Column({ type: "timestamp with time zone", nullable: true, name: "frozen_at" })
  frozenAt?: Date;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;

  // Computed / transient — masked display number, populated after load
  maskedNumber?: string;

  // Mask the PAN display after loading from DB
  @AfterLoad()
  maskCardNumber() {
    this.maskedNumber = `**** **** **** ${this.lastFour}`;
  }

  @ManyToOne(() => Account, (account) => account.cards, { onDelete: "CASCADE" })
  @JoinColumn({ name: "account_id" })
  account!: Account;
}
