import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  ManyToMany,
  JoinColumn,
  JoinTable,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  VersionColumn,
  RelationId,
  Index,
} from "typeorm";
import { User } from "./User.entity.js";
import { Category } from "./Category.entity.js";
import { Tag } from "./Tag.entity.js";

export enum PostStatus {
  DRAFT = "draft",
  REVIEW = "review",
  SCHEDULED = "scheduled",
  PUBLISHED = "published",
  ARCHIVED = "archived",
  DELETED = "deleted",
}

@Entity("posts")
@Index(["status", "publishedAt"])
@Index({ where: '"deleted_at" IS NULL' })  // partial index for non-deleted posts
export class Post {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 500, nullable: false })
  title!: string;

  @Column({ type: "varchar", length: 500, nullable: false, unique: true })
  slug!: string;

  @Column({ type: "text", nullable: true })
  excerpt?: string;

  @Column({ type: "text", nullable: false })
  body!: string;

  @Column({ type: "varchar", length: 500, nullable: true, name: "cover_url" })
  coverUrl?: string;

  @Column({
    type: "enum",
    enum: PostStatus,
    default: PostStatus.DRAFT,
  })
  status!: PostStatus;

  @Column({ type: "boolean", default: false, name: "is_featured" })
  isFeatured!: boolean;

  @Column({ type: "boolean", default: false, name: "is_pinned" })
  isPinned!: boolean;

  @Column({ type: "int", default: 0, name: "view_count" })
  viewCount!: number;

  @Column({ type: "int", default: 0, name: "like_count" })
  likeCount!: number;

  @Column({ type: "int", default: 0, name: "comment_count" })
  commentCount!: number;

  @Column({ type: "int", nullable: true, name: "reading_time" })
  readingTime?: number;

  @Column({ type: "jsonb", nullable: true, name: "meta" })
  meta?: {
    seoTitle?: string;
    seoDescription?: string;
    ogImage?: string;
    canonicalUrl?: string;
  };

  @Column({
    type: "simple-json",
    nullable: true,
    name: "toc",
  })
  tableOfContents?: Array<{ level: number; text: string; anchor: string }>;

  @Column({ type: "timestamp with time zone", nullable: true, name: "published_at" })
  publishedAt?: Date;

  @Column({ type: "timestamp with time zone", nullable: true, name: "scheduled_at" })
  scheduledAt?: Date;

  // Optimistic locking version
  @VersionColumn()
  version!: number;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;

  @DeleteDateColumn({ name: "deleted_at" })
  deletedAt?: Date;

  // Relations
  @ManyToOne(() => User, (user) => user.posts, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "author_id" })
  author!: User;

  @RelationId((post: Post) => post.author)
  authorId!: string;

  @ManyToOne(() => Category, (cat) => cat.posts, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "category_id" })
  category?: Category;

  @RelationId((post: Post) => post.category)
  categoryId?: number;

  @ManyToMany(() => Tag, (tag) => tag.posts)
  @JoinTable({
    name: "post_tags",
    joinColumn: { name: "post_id", referencedColumnName: "id" },
    inverseJoinColumn: { name: "tag_id", referencedColumnName: "id" },
  })
  tags!: Tag[];
}
