import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToMany,
  CreateDateColumn,
  Unique,
} from "typeorm";
import { Role } from "./Role.entity.js";

@Entity("permissions")
@Unique(["action", "resource"])
export class Permission {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 100, nullable: false })
  action!: string;  // 'create', 'read', 'update', 'delete', 'publish', '*'

  @Column({ type: "varchar", length: 100, nullable: false })
  resource!: string;  // 'post', 'comment', 'user', 'media', '*'

  @Column({ type: "varchar", length: 500, nullable: true })
  description?: string;

  @Column({ type: "varchar", length: 50, nullable: true })
  scope?: string;  // 'own', 'any', 'team'

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @ManyToMany(() => Role, (role) => role.permissions)
  roles!: Role[];
}
