import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Tree,
  TreeParent,
  TreeChildren,
  OneToMany,
} from "typeorm";
import { Post } from "./Post.entity.js";

@Entity("categories")
@Tree("closure-table")
export class Category {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 200, nullable: false })
  name!: string;

  @Column({ type: "varchar", length: 200, nullable: false, unique: true })
  slug!: string;

  @Column({ type: "text", nullable: true })
  description?: string;

  @Column({ type: "varchar", length: 500, nullable: true, name: "image_url" })
  imageUrl?: string;

  @Column({ type: "boolean", default: true, name: "is_active" })
  isActive!: boolean;

  @Column({ type: "int", default: 0, name: "sort_order" })
  sortOrder!: number;

  @Column({ type: "int", default: 0, name: "post_count" })
  postCount!: number;

  @Column({ type: "jsonb", nullable: true, name: "seo_meta" })
  seoMeta?: { title?: string; description?: string; keywords?: string[] };

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;

  // Tree relations (managed by TypeORM closure-table strategy)
  @TreeParent({ onDelete: "SET NULL" })
  parent!: Category;

  @TreeChildren()
  children!: Category[];

  @OneToMany(() => Post, (post) => post.category)
  posts!: Post[];
}
