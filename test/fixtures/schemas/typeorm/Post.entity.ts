import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
} from "typeorm";
import { User } from "./User.entity.js";

@Entity("posts")
export class Post {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 200 })
  title!: string;

  @Column({ type: "boolean", default: false })
  published!: boolean;

  @ManyToOne(() => User, (user) => user.posts, { nullable: false })
  @JoinColumn({ name: "author_id" })
  author!: User;
}
