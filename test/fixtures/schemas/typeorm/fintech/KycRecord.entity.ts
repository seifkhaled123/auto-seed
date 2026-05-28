import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  OneToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
  VersionColumn,
} from "typeorm";
import { Customer } from "./Customer.entity.js";

export enum KycLevel {
  NONE = "none",
  BASIC = "basic",
  STANDARD = "standard",
  ENHANCED = "enhanced",
}

@Entity("kyc_records")
export class KycRecord {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "customer_id" })
  customerId!: string;

  @Column({
    type: "enum",
    enum: KycLevel,
    default: KycLevel.NONE,
    name: "level",
  })
  level!: KycLevel;

  // Documents uploaded for verification (ID scans, selfies, etc.)
  @Column({ type: "jsonb", default: [], name: "documents" })
  documents!: Array<{
    type: string;        // 'passport', 'drivers_license', 'proof_of_address'
    url: string;
    uploadedAt: string;
    status: string;
  }>;

  // Third-party KYC provider response data
  @Column({ type: "jsonb", nullable: true, name: "verification_data" })
  verificationData?: Record<string, unknown>;

  @Column({ type: "jsonb", nullable: true, name: "risk_signals" })
  riskSignals?: Record<string, unknown>;

  @Column({ type: "varchar", length: 100, nullable: true, name: "provider_ref" })
  providerRef?: string;  // external verification ID

  @Column({ type: "varchar", length: 200, nullable: true, name: "rejection_reason" })
  rejectionReason?: string;

  @Column({ type: "timestamp with time zone", nullable: true, name: "reviewed_at" })
  reviewedAt?: Date;

  @Column({ type: "varchar", length: 100, nullable: true, name: "reviewed_by" })
  reviewedBy?: string;

  @Column({ type: "timestamp with time zone", nullable: true, name: "expires_at" })
  expiresAt?: Date;

  // Optimistic locking — prevents concurrent KYC updates
  @VersionColumn()
  version!: number;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;

  @OneToOne(() => Customer, (customer) => customer.kycRecord, { onDelete: "CASCADE" })
  @JoinColumn({ name: "customer_id" })
  customer!: Customer;
}
