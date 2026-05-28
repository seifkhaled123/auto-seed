import { ViewEntity, ViewColumn, DataSource } from "typeorm";

// ── PostStatsView — aggregated stats per post per day ─────────
// This is a TypeORM @ViewEntity backed by a database view.
// The view is read-only; TypeORM will not create INSERT/UPDATE migrations.
@ViewEntity({
  name: "post_stats_view",
  expression: (dataSource: DataSource) =>
    dataSource
      .createQueryBuilder()
      .select("p.id", "postId")
      .addSelect("p.title", "title")
      .addSelect("p.status", "status")
      .addSelect("p.author_id", "authorId")
      .addSelect("p.view_count", "viewCount")
      .addSelect("p.like_count", "likeCount")
      .addSelect("p.comment_count", "commentCount")
      .addSelect("DATE_TRUNC('day', p.published_at)", "publishedDay")
      .addSelect(
        "COALESCE(p.view_count::FLOAT / NULLIF(EXTRACT(EPOCH FROM (NOW() - p.published_at)) / 86400, 0), 0)",
        "dailyViewRate",
      )
      .from("posts", "p")
      .where("p.deleted_at IS NULL")
      .andWhere("p.status = 'published'"),
})
export class PostStatsView {
  @ViewColumn({ name: "postId" })
  postId!: string;

  @ViewColumn({ name: "title" })
  title!: string;

  @ViewColumn({ name: "status" })
  status!: string;

  @ViewColumn({ name: "authorId" })
  authorId!: string;

  @ViewColumn({ name: "viewCount" })
  viewCount!: number;

  @ViewColumn({ name: "likeCount" })
  likeCount!: number;

  @ViewColumn({ name: "commentCount" })
  commentCount!: number;

  @ViewColumn({ name: "publishedDay" })
  publishedDay!: Date;

  @ViewColumn({ name: "dailyViewRate" })
  dailyViewRate!: number;
}
