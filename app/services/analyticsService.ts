import {
  and,
  asc,
  avg,
  count,
  countDistinct,
  eq,
  getTableColumns,
  gte,
  max,
  sql,
  sum,
  type SQL,
} from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { db } from "~/db";
import {
  courseRatings,
  courses,
  enrollments,
  LessonProgressStatus,
  lessonProgress,
  lessons,
  modules,
  purchases,
} from "~/db/schema";

/** Number of lessons currently in each course that has at least one. */
function lessonCountsByCourse() {
  return db
    .select({
      courseId: modules.courseId,
      lessonCount: count(lessons.id).as("lesson_count"),
    })
    .from(modules)
    .innerJoin(lessons, eq(lessons.moduleId, modules.id))
    .groupBy(modules.courseId)
    .as("lesson_counts");
}

/**
 * Every course owned by the instructor (any status), with its lesson and
 * student counts. One grouped query, rather than two count queries per course.
 */
export function getInstructorCourseStats(instructorId: number) {
  const lessonCounts = lessonCountsByCourse();

  const enrollmentCounts = db
    .select({
      courseId: enrollments.courseId,
      enrollmentCount: count(enrollments.id).as("enrollment_count"),
    })
    .from(enrollments)
    .groupBy(enrollments.courseId)
    .as("enrollment_counts");

  const rows = db
    .select({
      ...getTableColumns(courses),
      lessonCount: lessonCounts.lessonCount,
      enrollmentCount: enrollmentCounts.enrollmentCount,
    })
    .from(courses)
    .leftJoin(lessonCounts, eq(lessonCounts.courseId, courses.id))
    .leftJoin(enrollmentCounts, eq(enrollmentCounts.courseId, courses.id))
    .where(eq(courses.instructorId, instructorId))
    .orderBy(asc(courses.id))
    .all();

  // A course with no lessons or enrollments has no row in the grouped
  // subquery, so the left join yields null.
  return rows.map((row) => ({
    ...row,
    lessonCount: row.lessonCount ?? 0,
    enrollmentCount: row.enrollmentCount ?? 0,
  }));
}

const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Start of the rolling 30-day window, as a comparable ISO timestamp (UTC). */
function windowStart() {
  return new Date(Date.now() - WINDOW_MS).toISOString();
}

/** `column` falls in the window starting at `since`; no filter when all-time. */
function inWindow(column: SQLiteColumn, since?: string) {
  return since ? gte(column, since) : undefined;
}

function countStudents(scope: SQL, since?: string) {
  const row = db
    .select({ count: count() })
    .from(enrollments)
    .innerJoin(courses, eq(courses.id, enrollments.courseId))
    .where(and(scope, inWindow(enrollments.enrolledAt, since)))
    .get();
  return row?.count ?? 0;
}

/**
 * Completion rate (completed / enrolled) and how many students finished in the
 * window. A student has completed a course once they have a completed
 * lesson-progress record for every lesson currently in it; their finish date
 * is the latest of those completions. enrollments.completedAt is ignored —
 * nothing in the app sets it.
 */
function getCompletion(scope: SQL, since: string) {
  const lessonCounts = lessonCountsByCourse();

  const perEnrollment = db
    .select({
      lessonCount: lessonCounts.lessonCount,
      completedLessons: countDistinct(lessonProgress.lessonId),
      finishedAt: max(lessonProgress.completedAt),
    })
    .from(enrollments)
    .innerJoin(courses, eq(courses.id, enrollments.courseId))
    .leftJoin(lessonCounts, eq(lessonCounts.courseId, enrollments.courseId))
    .leftJoin(modules, eq(modules.courseId, enrollments.courseId))
    .leftJoin(lessons, eq(lessons.moduleId, modules.id))
    .leftJoin(
      lessonProgress,
      and(
        eq(lessonProgress.lessonId, lessons.id),
        eq(lessonProgress.userId, enrollments.userId),
        eq(lessonProgress.status, LessonProgressStatus.Completed)
      )
    )
    .where(scope)
    .groupBy(enrollments.id)
    .all();

  const finished = perEnrollment.filter(
    (e) => e.lessonCount !== null && e.completedLessons === e.lessonCount
  );

  return {
    rate:
      perEnrollment.length === 0 ? 0 : finished.length / perEnrollment.length,
    finishedLast30Days: finished.filter(
      (e) => e.finishedAt !== null && e.finishedAt >= since
    ).length,
  };
}

/** Average rating (null when there are none) and number of ratings. */
function getRating(scope: SQL, since?: string) {
  const row = db
    .select({ average: avg(courseRatings.rating), count: count() })
    .from(courseRatings)
    .innerJoin(courses, eq(courses.id, courseRatings.courseId))
    .where(and(scope, inWindow(courseRatings.createdAt, since)))
    .get();
  // Drizzle returns avg() as a string, or null over no rows.
  return {
    average: row?.average == null ? null : Number(row.average),
    count: row?.count ?? 0,
  };
}

/**
 * Revenue in cents: what was actually paid. PPP purchases store the discounted
 * amount, and a team purchase is a single row, so a plain sum is correct.
 */
function sumRevenue(scope: SQL, since?: string) {
  const row = db
    .select({ total: sum(purchases.amountPaid) })
    .from(purchases)
    .innerJoin(courses, eq(courses.id, purchases.courseId))
    .where(and(scope, inWindow(purchases.createdAt, since)))
    .get();
  // Drizzle returns sum() as a string, or null over no rows.
  return row?.total == null ? 0 : Number(row.total);
}

/**
 * The four headline KPIs (Students, Completion, Rating, Revenue), each
 * all-time and for the last 30 days, over the courses matched by `scope`.
 */
function getKpis(scope: SQL) {
  const since = windowStart();

  return {
    students: {
      allTime: countStudents(scope),
      last30Days: countStudents(scope, since),
    },
    completion: getCompletion(scope, since),
    rating: {
      allTime: getRating(scope),
      last30Days: getRating(scope, since),
    },
    revenue: {
      allTime: sumRevenue(scope),
      last30Days: sumRevenue(scope, since),
    },
  };
}

export type KpiSummary = ReturnType<typeof getKpis>;

/** The four KPIs across every course the instructor owns (any status). */
export function getInstructorSummary(instructorId: number) {
  return getKpis(eq(courses.instructorId, instructorId));
}

/**
 * For each lesson in course order (module position, then lesson position),
 * how many enrolled students completed it and what share of all enrolled
 * students that is (0 when nobody is enrolled). Completions by users who
 * aren't enrolled are ignored.
 */
function getDropOff(courseId: number, enrolled: number) {
  const rows = db
    .select({
      lessonId: lessons.id,
      title: lessons.title,
      completed: countDistinct(lessonProgress.userId),
    })
    .from(lessons)
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .leftJoin(enrollments, eq(enrollments.courseId, modules.courseId))
    .leftJoin(
      lessonProgress,
      and(
        eq(lessonProgress.lessonId, lessons.id),
        eq(lessonProgress.userId, enrollments.userId),
        eq(lessonProgress.status, LessonProgressStatus.Completed)
      )
    )
    .where(eq(modules.courseId, courseId))
    .groupBy(lessons.id)
    .orderBy(asc(modules.position), asc(lessons.position))
    .all();

  return rows.map((row) => ({
    ...row,
    rate: enrolled === 0 ? 0 : row.completed / enrolled,
  }));
}

/** Analytics for a single course: its four KPIs and lesson drop-off. */
export function getCourseAnalytics(courseId: number) {
  const kpis = getKpis(eq(courses.id, courseId));
  return {
    kpis,
    dropOff: getDropOff(courseId, kpis.students.allTime),
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_ENROLLMENT_DAYS = 30;

/** The UTC calendar day of `date`, as "YYYY-MM-DD". */
function utcDay(date: Date) {
  return date.toISOString().slice(0, 10);
}

/**
 * New enrollments per UTC day across every course the instructor owns: exactly
 * 30 calendar days ending today (UTC), oldest first, with days without
 * enrollments as 0. Unlike the rolling KPI window, the first day is whole.
 */
export function getDailyEnrollments(instructorId: number) {
  const today = Date.parse(utcDay(new Date()));
  const dates = Array.from({ length: DAILY_ENROLLMENT_DAYS }, (_, i) =>
    utcDay(new Date(today - (DAILY_ENROLLMENT_DAYS - 1 - i) * DAY_MS))
  );

  // enrolledAt is stored via toISOString() (UTC), so its first 10 chars are
  // the same "YYYY-MM-DD" day as utcDay().
  const day = sql<string>`substr(${enrollments.enrolledAt}, 1, 10)`;
  const rows = db
    .select({ date: day, count: count() })
    .from(enrollments)
    .innerJoin(courses, eq(courses.id, enrollments.courseId))
    .where(
      and(
        eq(courses.instructorId, instructorId),
        gte(enrollments.enrolledAt, dates[0])
      )
    )
    .groupBy(day)
    .all();

  const counts = new Map(rows.map((r) => [r.date, r.count]));
  return dates.map((date) => ({ date, count: counts.get(date) ?? 0 }));
}
