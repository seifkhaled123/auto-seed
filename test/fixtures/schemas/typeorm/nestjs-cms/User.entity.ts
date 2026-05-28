import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  OneToMany,
  ManyToMany,
  BeforeInsert,
  BeforeUpdate,
  Unique,
  Index,
} from "typeorm";
import { Post } from "./Post.entity.js";
import { Role } from "./Role.entity.js";

export enum UserRole {
  USER = "user",
  AUTHOR = "author",
  EDITOR = "editor",
  MODERATOR = "moderator",
  ADMIN = "admin",
}

export enum UserStatus {
  PENDING = "pending",
  ACTIVE = "active",
  SUSPENDED = "suspended",
  DEACTIVATED = "deactivated",
}

@Entity("users")
@Unique(["email"])
@Index(["status", "createdAt"])
export class User {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 320, nullable: false })
  email!: string;

  @Column({ type: "boolean", default: false, name: "email_verified" })
  emailVerified!: boolean;

  @Column({ type: "varchar", length: 255, name: "password_hash", nullable: false })
  passwordHash!: string;

  @Column({ type: "varchar", length: 120, name: "first_name" })
  firstName!: string;

  @Column({ type: "varchar", length: 120, name: "last_name" })
  lastName!: string;

  @Column({ type: "varchar", length: 120, nullable: true })
  username?: string;

  @Column({ type: "text", nullable: true })
  bio?: string;

  @Column({ type: "varchar", length: 500, nullable: true, name: "avatar_url" })
  avatarUrl?: string;

  @Column({ type: "varchar", length: 500, nullable: true, name: "website_url" })
  websiteUrl?: string;

  @Column({
    type: "enum",
    enum: UserRole,
    default: UserRole.USER,
  })
  role!: UserRole;

  @Column({
    type: "enum",
    enum: UserStatus,
    default: UserStatus.PENDING,
    name: "status",
  })
  status!: UserStatus;

  @Column({ type: "varchar", length: 10, default: "en" })
  locale!: string;

  @Column({ type: "varchar", length: 100, default: "UTC" })
  timezone!: string;

  @Column({ type: "jsonb", default: {}, name: "preferences" })
  preferences!: Record<string, unknown>;

  @Column({ type: "jsonb", nullable: true, name: "social_links" })
  socialLinks?: Record<string, string>;

  @Column({ type: "varchar", length: 100, nullable: true, name: "stripe_customer_id" })
  stripeCustomerId?: string;

  @Column({ type: "timestamp with time zone", nullable: true, name: "last_login_at" })
  lastLoginAt?: Date;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;

  @DeleteDateColumn({ name: "deleted_at" })
  deletedAt?: Date;

  // Relations
  @OneToMany(() => Post, (post) => post.author)
  posts!: Post[];

  @ManyToMany(() => Role, (role) => role.users)
  roles!: Role[];

  // Lifecycle hooks
  @BeforeInsert()
  normalizeEmail() {
    this.email = this.email.toLowerCase().trim();
  }

  @BeforeUpdate()
  normalizeEmailOnUpdate() {
    if (this.email) {
      this.email = this.email.toLowerCase().trim();
    }
  }
}
