import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  Index,
} from "typeorm";
import { Customer } from "./Customer.entity.js";

export enum NotificationChannel {
  PUSH = "push",
  EMAIL = "email",
  SMS = "sms",
  IN_APP = "in_app",
  WEBHOOK = "webhook",
}

export enum NotificationType {
  TRANSACTION = "transaction",
  TRANSFER = "transfer",
  SECURITY = "security",
  KYC = "kyc",
  ACCOUNT = "account",
  CARD = "card",
  MARKETING = "marketing",
  SYSTEM = "system",
}

@Entity("notifications")
@Index(["customerId", "isRead", "createdAt"])
@Index(["channel", "createdAt"])
export class Notification {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", nullable: true, name: "customer_id" })
  customerId?: string;

  @Column({
    type: "enum",
    enum: NotificationChannel,
    default: NotificationChannel.IN_APP,
  })
  channel!: NotificationChannel;

  @Column({
    type: "enum",
    enum: NotificationType,
  })
  type!: NotificationType;

  @Column({ type: "varchar", length: 500 })
  title!: string;

  @Column({ type: "text", nullable: true })
  body?: string;

  @Column({ type: "varchar", length: 500, nullable: true, name: "action_url" })
  actionUrl?: string;

  @Column({ type: "jsonb", nullable: true })
  payload?: Record<string, unknown>;

  @Column({ type: "boolean", default: false, name: "is_read" })
  isRead!: boolean;

  @Column({ type: "timestamp with time zone", nullable: true, name: "read_at" })
  readAt?: Date;

  // Delivery tracking
  @Column({ type: "timestamp with time zone", nullable: true, name: "sent_at" })
  sentAt?: Date;

  @Column({ type: "timestamp with time zone", nullable: true, name: "delivered_at" })
  deliveredAt?: Date;

  @Column({ type: "varchar", length: 100, nullable: true, name: "delivery_id" })
  deliveryId?: string;  // provider message ID (FCM, Twilio, SES, etc.)

  @Column({ type: "varchar", length: 200, nullable: true, name: "failure_reason" })
  failureReason?: string;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @ManyToOne(() => Customer, (customer) => customer.notifications, {
    nullable: true,
    onDelete: "CASCADE",
  })
  @JoinColumn({ name: "customer_id" })
  customer?: Customer;
}
