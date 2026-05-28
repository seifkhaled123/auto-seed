import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToMany,
  CreateDateColumn,
  Unique,
} from "typeorm";
import { Post } from "./Post.entity.js";

@Entity("tags")
@Unique(["slug"])
export class Tag {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 100, nullable: false })
  name!: string;

  @Column({ type: "varchar", length: 100, nullable: false })
  slug!: string;

  @Column({ type: "varchar", length: 7, nullable: true })
  color?: string;  // hex color code

  @Column({ type: "int", default: 0, name: "usage_count" })
  usageCount!: number;

  @Column({ type: "boolean", default: true, name: "is_active" })
  isActive!: boolean;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @ManyToMany(() => Post, (post) => post.tags)
  posts!: Post[];
}
