import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  OneToMany,
  CreateDateColumn,
  Unique,
} from "typeorm";
import { Post } from "./Post.entity.js";

@Entity("users")
@Unique(["email"])
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255, nullable: false })
  email!: string;

  @Column({ type: "varchar", length: 120 })
  name!: string;

  @Column({ type: "varchar", enum: ["USER", "ADMIN"], default: "USER" })
  role!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @OneToMany(() => Post, (post) => post.author)
  posts!: Post[];
}
