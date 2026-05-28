import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToOne,
  OneToMany,
  Index,
  Unique,
} from "typeorm";
import { KycRecord } from "./KycRecord.entity.js";
import { Account } from "./Account.entity.js";
import { Beneficiary } from "./Beneficiary.entity.js";
import { Notification } from "./Notification.entity.js";

export enum KycStatus {
  NOT_STARTED = "not_started",
  PENDING = "pending",
  UNDER_REVIEW = "under_review",
  APPROVED = "approved",
  REJECTED = "rejected",
  EXPIRED = "expired",
}

export enum CustomerStatus {
  ACTIVE = "active",
  RESTRICTED = "restricted",
  SUSPENDED = "suspended",
  CLOSED = "closed",
}

@Entity("customers")
@Unique(["email"])
@Index(["status"])
@Index(["createdAt"])
export class Customer {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 320, nullable: false })
  email!: string;

  @Column({ type: "boolean", default: false, name: "email_verified" })
  emailVerified!: boolean;

  @Column({ type: "varchar", length: 30, nullable: true })
  phone?: string;

  @Column({ type: "boolean", default: false, name: "phone_verified" })
  phoneVerified!: boolean;

  @Column({ type: "varchar", length: 120, name: "first_name" })
  firstName!: string;

  @Column({ type: "varchar", length: 120, name: "last_name" })
  lastName!: string;

  @Column({ type: "date", nullable: true, name: "date_of_birth" })
  dateOfBirth?: Date;

  @Column({ type: "char", length: 2, nullable: true, name: "country_code" })
  countryCode?: string;

  @Column({ type: "varchar", length: 500, nullable: true, name: "address_line1" })
  addressLine1?: string;

  @Column({ type: "varchar", length: 500, nullable: true, name: "address_line2" })
  addressLine2?: string;

  @Column({ type: "varchar", length: 200, nullable: true })
  city?: string;

  @Column({ type: "varchar", length: 100, nullable: true })
  state?: string;

  @Column({ type: "varchar", length: 20, nullable: true, name: "postal_code" })
  postalCode?: string;

  @Column({ type: "varchar", length: 100, nullable: true, name: "tax_id" })
  taxId?: string;  // encrypted in production

  @Column({
    type: "enum",
    enum: KycStatus,
    default: KycStatus.NOT_STARTED,
    name: "kyc_status",
  })
  kycStatus!: KycStatus;

  @Column({
    type: "enum",
    enum: CustomerStatus,
    default: CustomerStatus.ACTIVE,
  })
  status!: CustomerStatus;

  @Column({ type: "varchar", length: 10, default: "en" })
  locale!: string;

  @Column({ type: "char", length: 3, default: "USD", name: "preferred_currency" })
  preferredCurrency!: string;

  @Column({ type: "jsonb", nullable: true, name: "risk_profile" })
  riskProfile?: Record<string, unknown>;

  @Column({ type: "timestamp with time zone", nullable: true, name: "last_login_at" })
  lastLoginAt?: Date;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;

  @OneToOne(() => KycRecord, (kyc) => kyc.customer)
  kycRecord?: KycRecord;

  @OneToMany(() => Account, (account) => account.customer)
  accounts!: Account[];

  @OneToMany(() => Beneficiary, (b) => b.customer)
  beneficiaries!: Beneficiary[];

  @OneToMany(() => Notification, (n) => n.customer)
  notifications!: Notification[];
}
