import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Unique,
  Index,
} from "typeorm";
import { Customer } from "./Customer.entity.js";

export enum BeneficiaryType {
  INDIVIDUAL = "individual",
  BUSINESS = "business",
}

export enum BeneficiaryStatus {
  PENDING = "pending",
  VERIFIED = "verified",
  REJECTED = "rejected",
  REMOVED = "removed",
}

@Entity("beneficiaries")
@Unique(["customerId", "accountNumber"])
@Index(["customerId", "status"])
export class Beneficiary {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "customer_id" })
  customerId!: string;

  @Column({ type: "varchar", length: 255, name: "nickname" })
  nickname!: string;

  @Column({
    type: "enum",
    enum: BeneficiaryType,
    default: BeneficiaryType.INDIVIDUAL,
  })
  type!: BeneficiaryType;

  @Column({
    type: "enum",
    enum: BeneficiaryStatus,
    default: BeneficiaryStatus.PENDING,
  })
  status!: BeneficiaryStatus;

  @Column({ type: "varchar", length: 255, name: "account_holder_name" })
  accountHolderName!: string;

  @Column({ type: "varchar", length: 50, name: "account_number" })
  accountNumber!: string;

  @Column({ type: "char", length: 2, name: "bank_country" })
  bankCountry!: string;

  @Column({ type: "char", length: 3 })
  currency!: string;

  // Bank details stored as JSON (structure varies by country/method)
  @Column({ type: "jsonb", name: "bank_details" })
  bankDetails!: {
    bankName?: string;
    branchCode?: string;
    routingNumber?: string;
    iban?: string;
    swiftCode?: string;
    sortCode?: string;
    bsb?: string;
    [key: string]: unknown;
  };

  @Column({ type: "varchar", length: 500, nullable: true })
  address?: string;

  @Column({ type: "boolean", default: false, name: "is_trusted" })
  isTrusted!: boolean;

  @Column({ type: "timestamp with time zone", nullable: true, name: "verified_at" })
  verifiedAt?: Date;

  @Column({ type: "timestamp with time zone", nullable: true, name: "last_used_at" })
  lastUsedAt?: Date;

  @Column({ type: "int", default: 0, name: "transfer_count" })
  transferCount!: number;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;

  @ManyToOne(() => Customer, (customer) => customer.beneficiaries, { onDelete: "CASCADE" })
  @JoinColumn({ name: "customer_id" })
  customer!: Customer;
}
